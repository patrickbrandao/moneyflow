/*
 * PIX copia-e-cola (BR Code, EMV QRCPS-MPM). A validação estrutural e o CRC
 * seguem a função is_valid_brcode do banco (database/migrations/0012_title_entry.sql).
 */
import { guessPixKeyType, normalizePixKey, type PixKeyType } from './pix';

export type BrCodeResult =
  | {
      ok: true;
      payload: string;
      pixKey: string | null;
      pixKeyType: PixKeyType | null;
      description: string | null;
      /** URL do payload dinâmico (campo 26.25). */
      url: string | null;
      merchantName: string | null;
      merchantCity: string | null;
      postalCode: string | null;
      amountCents: number | null;
      txid: string | null;
      mcc: string | null;
      dynamic: boolean;
    }
  | { ok: false; error: string };

const encoder = new TextEncoder();

/** CRC-16/CCITT-FALSE (polinômio 0x1021, inicial 0xFFFF) sobre os bytes UTF-8; 4 hex maiúsculos. */
export function crc16(payload: string): string {
  let crc = 0xffff;
  for (const byte of encoder.encode(payload)) {
    crc ^= byte << 8;
    for (let b = 0; b < 8; b += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export type EmvField = { id: string; value: string };

/** Lê uma sequência TLV (ID 2 dígitos + tamanho 2 dígitos + valor). Tamanho conta caracteres. */
export function parseEmvTlv(text: string): EmvField[] | null {
  const out: EmvField[] = [];
  let i = 0;
  while (i < text.length) {
    const head = text.slice(i, i + 4);
    if (!/^[0-9]{4}$/.test(head)) return null;
    const len = Number(head.slice(2));
    const value = text.slice(i + 4, i + 4 + len);
    if (value.length !== len) return null;
    out.push({ id: head.slice(0, 2), value });
    i += 4 + len;
  }
  return out;
}

const get = (fields: EmvField[], id: string) => fields.find((f) => f.id === id)?.value ?? null;

/** Valor decimal "123.45" → centavos. */
function amountToCents(value: string): number | null {
  if (!/^[0-9]+(\.[0-9]{1,2})?$/.test(value)) return null;
  const [int, frac = ''] = value.split('.');
  return Number(int) * 100 + Number(frac.padEnd(2, '0'));
}

export function parseBrCode(input: string): BrCodeResult {
  const payload = input.trim();
  if (payload.length < 30 || payload.length > 512) return { ok: false, error: 'O PIX copia-e-cola deve ter de 30 a 512 caracteres.' };
  if (!payload.startsWith('000201')) return { ok: false, error: 'O PIX copia-e-cola deve começar com 000201.' };
  if (!/6304[0-9A-Fa-f]{4}$/.test(payload)) return { ok: false, error: 'O PIX copia-e-cola não termina com o CRC (campo 63).' };
  if (!payload.toLowerCase().includes('br.gov.bcb.pix')) return { ok: false, error: 'O código não é um PIX (falta br.gov.bcb.pix).' };
  if (crc16(payload.slice(0, -4)) !== payload.slice(-4).toUpperCase()) {
    return { ok: false, error: 'CRC do PIX copia-e-cola inválido.' };
  }
  const fields = parseEmvTlv(payload);
  if (!fields) return { ok: false, error: 'Estrutura do PIX copia-e-cola inválida.' };

  // Conta do recebedor: um dos campos 26–51 com o GUI br.gov.bcb.pix.
  let account: EmvField[] | null = null;
  for (const f of fields) {
    const n = Number(f.id);
    if (n < 26 || n > 51) continue;
    const sub = parseEmvTlv(f.value);
    if (sub && get(sub, '00')?.toLowerCase() === 'br.gov.bcb.pix') {
      account = sub;
      break;
    }
  }
  if (!account) return { ok: false, error: 'O PIX copia-e-cola não tem a conta do recebedor.' };

  const rawKey = get(account, '01');
  const url = get(account, '25');
  let pixKey: string | null = null;
  let pixKeyType: PixKeyType | null = null;
  if (rawKey) {
    pixKeyType = guessPixKeyType(rawKey);
    pixKey = pixKeyType ? normalizePixKey(pixKeyType, rawKey) : rawKey.trim();
  }
  if (!pixKey && !url) return { ok: false, error: 'O PIX copia-e-cola não tem chave nem URL.' };

  const amountText = get(fields, '54');
  const amountCents = amountText ? amountToCents(amountText) : null;
  if (amountText && amountCents === null) return { ok: false, error: 'Valor do PIX copia-e-cola inválido.' };

  const additional = get(fields, '62');
  const additionalFields = additional ? parseEmvTlv(additional) : null;
  const txid = additionalFields ? get(additionalFields, '05') : null;

  return {
    ok: true,
    payload,
    pixKey,
    pixKeyType,
    description: get(account, '02'),
    url,
    merchantName: get(fields, '59'),
    merchantCity: get(fields, '60'),
    postalCode: get(fields, '61'),
    amountCents: amountCents && amountCents > 0 ? amountCents : null,
    txid: txid && txid !== '***' ? txid : null,
    mcc: get(fields, '52'),
    dynamic: url !== null || get(fields, '01') === '12',
  };
}

const tlv = (id: string, value: string) => `${id}${String(value.length).padStart(2, '0')}${value}`;

/** Remove acentos e limita o tamanho (nome e cidade do recebedor são ASCII no BR Code). */
const ascii = (text: string, max: number) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').slice(0, max);

/** Monta um BR Code estático (útil para fixtures e testes). */
export function buildBrCode(input: {
  pixKey: string;
  merchantName: string;
  merchantCity: string;
  amountCents?: number | null;
  txid?: string | null;
  description?: string | null;
}): string {
  const account = tlv('00', 'br.gov.bcb.pix') + tlv('01', input.pixKey) + (input.description ? tlv('02', input.description) : '');
  let payload = tlv('00', '01') + tlv('26', account) + tlv('52', '0000') + tlv('53', '986');
  if (input.amountCents && input.amountCents > 0) payload += tlv('54', (input.amountCents / 100).toFixed(2));
  payload += tlv('58', 'BR') + tlv('59', ascii(input.merchantName, 25)) + tlv('60', ascii(input.merchantCity, 15));
  payload += tlv('62', tlv('05', input.txid || '***'));
  payload += '6304';
  return payload + crc16(payload);
}
