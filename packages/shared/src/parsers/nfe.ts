/*
 * Import de NF-e (spec 010): XML <nfeProc> (com <NFe> e <protNFe>) ou só
 * <NFe>, com ou sem namespace/prefixo. A chave de acesso segue a mesma regra
 * de is_valid_nfe_access_key do banco (database/migrations/0012_title_entry.sql).
 */
import { find, findAll, findFirst, parseXml, textOf, type XmlNode } from './xml';

export type NfeAddress = {
  street: string | null;
  number: string | null;
  complement: string | null;
  district: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
};

export type NfeItem = {
  itemNumber: number;
  productCode: string | null;
  description: string;
  ncm: string | null;
  cfop: string | null;
  unit: string | null;
  quantity: number;
  /** Pode ter casas decimais (vUnCom tem até 10 casas). */
  unitPriceCents: number;
  totalCents: number;
};

export type NfeDuplicate = { number: string | null; dueDate: string | null; amountCents: number };

export type NfeData = {
  accessKey: string;
  number: number;
  series: number;
  /** ISO de dhEmi (ou dEmi). */
  issuedAt: string;
  model: string | null;
  issuer: {
    document: string;
    name: string;
    tradeName: string | null;
    stateRegistration: string | null;
    address: NfeAddress | null;
  };
  recipient: { document: string | null; name: string | null } | null;
  totalCents: number;
  items: NfeItem[];
  duplicates: NfeDuplicate[];
  paymentDueDate: string | null;
};

/** Chave de acesso: 44 dígitos e DV módulo 11 (pesos 2..9 da direita; resto 0 ou 1 → 0). */
export function isValidNfeAccessKey(key: string): boolean {
  if (!/^[0-9]{44}$/.test(key)) return false;
  return nfeAccessKeyDv(key.slice(0, 43)) === Number(key[43]);
}

/** DV da chave a partir dos 43 primeiros dígitos (útil em geradores e testes). */
export function nfeAccessKeyDv(base43: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = base43.length - 1; i >= 0; i -= 1) {
    sum += Number(base43[i]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const r = sum % 11;
  return r === 0 || r === 1 ? 0 : 11 - r;
}

/** Decimal do XML ('123.45', '1.5000000000') → centavos (com casas decimais quando houver). */
function decimalToCents(value: string | null, exact = false): number | null {
  if (value === null || !/^-?\d+(\.\d+)?$/.test(value)) return null;
  const cents = Number(value) * 100;
  return exact ? Math.round(cents * 1e6) / 1e6 : Math.round(cents);
}

const digitsOnly = (s: string | null) => (s ? s.replace(/[^0-9A-Za-z]/g, '').toUpperCase() : null);

function address(node: XmlNode | null): NfeAddress | null {
  if (!node) return null;
  return {
    street: textOf(node, 'xLgr'),
    number: textOf(node, 'nro'),
    complement: textOf(node, 'xCpl'),
    district: textOf(node, 'xBairro'),
    city: textOf(node, 'xMun'),
    state: textOf(node, 'UF'),
    postalCode: digitsOnly(textOf(node, 'CEP')),
  };
}

export function parseNfeXml(xml: string): NfeData {
  let root: XmlNode;
  try {
    root = parseXml(xml);
  } catch {
    throw new Error('Arquivo XML inválido.');
  }
  const infNFe = findFirst(root, 'infNFe');
  if (!infNFe || !find(infNFe, ['ide'])) throw new Error('O XML não é uma NF-e (falta infNFe/ide).');

  const idKey = (infNFe.attrs.Id ?? '').replace(/^NFe/i, '');
  const protKey = textOf(findFirst(root, 'infProt'), 'chNFe');
  const accessKey = /^[0-9]{44}$/.test(idKey) ? idKey : (protKey ?? idKey);
  if (!isValidNfeAccessKey(accessKey)) throw new Error('Chave de acesso da NF-e inválida.');

  const ide = find(infNFe, ['ide'])!;
  const emit = find(infNFe, ['emit']);
  if (!emit) throw new Error('NF-e sem emitente (emit).');
  const issuerDocument = digitsOnly(textOf(emit, 'CNPJ') ?? textOf(emit, 'CPF'));
  const issuerName = textOf(emit, 'xNome');
  if (!issuerDocument || !issuerName) throw new Error('NF-e sem documento ou nome do emitente.');

  const dest = find(infNFe, ['dest']);
  const recipient = dest
    ? { document: digitsOnly(textOf(dest, 'CNPJ') ?? textOf(dest, 'CPF') ?? textOf(dest, 'idEstrangeiro')), name: textOf(dest, 'xNome') }
    : null;

  const total = decimalToCents(textOf(find(infNFe, ['total', 'ICMSTot']), 'vNF'));
  if (total === null) throw new Error('NF-e sem valor total (total/ICMSTot/vNF).');

  const issuedRaw = textOf(ide, 'dhEmi') ?? textOf(ide, 'dEmi');
  if (!issuedRaw) throw new Error('NF-e sem data de emissão (dhEmi).');

  const items: NfeItem[] = infNFe.children
    .filter((c) => c.name === 'det')
    .map((det, idx) => {
      const prod = find(det, ['prod']);
      return {
        itemNumber: Number(det.attrs.nItem ?? idx + 1),
        productCode: textOf(prod, 'cProd'),
        description: textOf(prod, 'xProd') ?? '',
        ncm: textOf(prod, 'NCM'),
        cfop: textOf(prod, 'CFOP'),
        unit: textOf(prod, 'uCom'),
        quantity: Number(textOf(prod, 'qCom') ?? '0'),
        unitPriceCents: decimalToCents(textOf(prod, 'vUnCom'), true) ?? 0,
        totalCents: decimalToCents(textOf(prod, 'vProd')) ?? 0,
      };
    });

  const duplicates: NfeDuplicate[] = findAll(find(infNFe, ['cobr']), 'dup').map((dup) => ({
    number: textOf(dup, 'nDup'),
    dueDate: textOf(dup, 'dVenc'),
    amountCents: decimalToCents(textOf(dup, 'vDup')) ?? 0,
  }));
  const dueDates = duplicates.map((d) => d.dueDate).filter((d): d is string => !!d);

  return {
    accessKey,
    number: Number(textOf(ide, 'nNF') ?? accessKey.slice(25, 34)),
    series: Number(textOf(ide, 'serie') ?? accessKey.slice(22, 25)),
    issuedAt: issuedRaw,
    model: textOf(ide, 'mod'),
    issuer: {
      document: issuerDocument,
      name: issuerName,
      tradeName: textOf(emit, 'xFant'),
      stateRegistration: textOf(emit, 'IE'),
      address: address(find(emit, ['enderEmit'])),
    },
    recipient,
    totalCents: total,
    items,
    duplicates,
    paymentDueDate: dueDates.length ? dueDates.sort()[0]! : null,
  };
}
