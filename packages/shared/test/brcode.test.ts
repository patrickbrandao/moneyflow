import { describe, expect, it } from 'vitest';
import { buildBrCode, crc16, parseBrCode, parseEmvTlv } from '../src/brcode';

// Conferido com is_valid_brcode do banco.
const BR =
  '00020126590014br.gov.bcb.pix0118fulano@exemplo.com0215Aluguel outubro5204000053039865406123.455802BR5913Fulano de Tal6009Sao Paulo62130509PEDIDO1236304CB0B';

describe('BR Code', () => {
  it('CRC-16/CCITT-FALSE', () => {
    expect(crc16('123456789')).toBe('29B1');
    expect(crc16(BR.slice(0, -4))).toBe('CB0B');
  });
  it('lê o PIX estático', () => {
    expect(parseBrCode(BR)).toEqual({
      ok: true,
      payload: BR,
      pixKey: 'fulano@exemplo.com',
      pixKeyType: 'email',
      description: 'Aluguel outubro',
      url: null,
      merchantName: 'Fulano de Tal',
      merchantCity: 'Sao Paulo',
      postalCode: null,
      amountCents: 12345,
      txid: 'PEDIDO123',
      mcc: '0000',
      dynamic: false,
    });
  });
  it('monta e relê com chave CPF, sem valor', () => {
    const code = buildBrCode({ pixKey: '12345678909', merchantName: 'José Ação', merchantCity: 'Belo Horizonte' });
    const r = parseBrCode(code);
    expect(r).toMatchObject({
      ok: true,
      pixKey: '12345678909',
      pixKeyType: 'cpf',
      merchantName: 'Jose Acao',
      amountCents: null,
      txid: null,
    });
  });
  it('monta e relê com chave CNPJ alfanumérica', () => {
    const code = buildBrCode({ pixKey: '12ABC34501DE35', merchantName: 'Alfa Exemplo', merchantCity: 'Sao Paulo', amountCents: 2500 });
    expect(parseBrCode(code)).toMatchObject({ ok: true, pixKey: '12ABC34501DE35', pixKeyType: 'cnpj', amountCents: 2500 });
    // A chave pode vir pontuada e em minúsculas: normaliza como o banco grava.
    const loose = buildBrCode({ pixKey: '12.abc.345/01de-35', merchantName: 'Alfa Exemplo', merchantCity: 'Sao Paulo' });
    expect(parseBrCode(loose)).toMatchObject({ ok: true, pixKey: '12ABC34501DE35', pixKeyType: 'cnpj' });
  });
  it('normaliza telefone e reconhece o dinâmico', () => {
    expect(parseBrCode(buildBrCode({ pixKey: '+5511987654321', merchantName: 'A', merchantCity: 'B', amountCents: 100 }))).toMatchObject({
      pixKey: '+5511987654321',
      pixKeyType: 'phone',
      amountCents: 100,
    });
    expect(parseEmvTlv('0005AB')).toBeNull();
    const payload = buildDynamic();
    expect(parseBrCode(payload)).toMatchObject({ ok: true, dynamic: true, url: 'pix.exemplo.com/qr/v2/abc', pixKey: null, txid: null });
  });
  it('rejeita CRC, prefixo, tamanho e GUI', () => {
    expect(parseBrCode(`${BR.slice(0, -4)}0000`)).toMatchObject({ ok: false, error: expect.stringContaining('CRC') });
    expect(parseBrCode(`1${BR.slice(1)}`).ok).toBe(false);
    expect(parseBrCode('000201').ok).toBe(false);
    expect(parseBrCode(BR.slice(0, -8)).ok).toBe(false);
    const noPix = BR.replace('br.gov.bcb.pix', 'br.gov.bcb.xyz');
    expect(parseBrCode(noPix.slice(0, -4) + crc16(noPix.slice(0, -4))).ok).toBe(false);
  });
});

function buildDynamic(): string {
  const tlv = (id: string, v: string) => `${id}${String(v.length).padStart(2, '0')}${v}`;
  const account = tlv('00', 'br.gov.bcb.pix') + tlv('25', 'pix.exemplo.com/qr/v2/abc');
  const body = `${tlv('00', '01')}${tlv('01', '12')}${tlv('26', account)}${tlv('52', '0000')}${tlv('53', '986')}${tlv('58', 'BR')}${tlv('59', 'LOJA')}${tlv('60', 'SAO PAULO')}${tlv('62', tlv('05', '***'))}6304`;
  return body + crc16(body);
}
