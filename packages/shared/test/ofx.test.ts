import { describe, expect, it } from 'vitest';
import { decodeStatementFile, parseOfx, parseOfxAmount, parseOfxDate } from '../src/parsers/ofx';
import { fixtureBytes } from './fixtures';

const sum = (xs: { amountCents: number }[]) => xs.reduce((s, x) => s + x.amountCents, 0);

describe('decodeStatementFile', () => {
  it('lê windows-1252 declarado no cabeçalho OFX 1.x', () => {
    const bytes = fixtureBytes('extrato-ofx1.ofx');
    expect(bytes.includes(0xe3)).toBe(true); // "ã" em 1252, não UTF-8
    const text = decodeStatementFile(bytes);
    expect(text).toContain('João da Silva');
    expect(text).toContain('COMPRA CARTÃO DÉBITO');
  });
  it('usa UTF-8 com e sem BOM', () => {
    const utf8 = new TextEncoder().encode('Pão');
    expect(decodeStatementFile(utf8)).toBe('Pão');
    expect(decodeStatementFile(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]))).toBe('Pão');
    expect(decodeStatementFile(new Uint8Array([0x50, 0xe3, 0x6f]))).toBe('Pão');
  });
});

describe('parseOfx', () => {
  it('OFX 1.x (SGML)', () => {
    const st = parseOfx(decodeStatementFile(fixtureBytes('extrato-ofx1.ofx')));
    expect(st).toMatchObject({
      kind: 'bank',
      bankId: '0341',
      accountId: '12345-6',
      currency: 'BRL',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      ledgerBalance: { amountCents: 441714, date: '2026-10-31' },
    });
    expect(st.transactions).toHaveLength(8);
    expect(sum(st.transactions)).toBe(341714);
    expect(st.transactions[0]).toEqual({
      fitid: 'OFX1-20261001-001',
      postedOn: '2026-10-01',
      amountCents: -15000,
      type: 'DEBIT',
      name: 'PIX ENVIADO',
      memo: 'João da Silva',
      checkNum: null,
      description: 'PIX ENVIADO João da Silva',
    });
    expect(st.transactions[2]!.amountCents).toBe(-8990); // vírgula decimal
    expect(st.transactions[7]).toMatchObject({ checkNum: '000123', description: 'CHEQUE COMPENSADO', type: 'CHECK' });
    expect(new Set(st.transactions.map((t) => t.fitid)).size).toBe(8);
  });
  it('OFX 2.x (XML)', () => {
    const st = parseOfx(decodeStatementFile(fixtureBytes('extrato-ofx2.ofx')));
    expect(st).toMatchObject({
      kind: 'bank',
      bankId: '077',
      accountId: '12345-6',
      ledgerBalance: { amountCents: 278620, date: '2026-10-31' },
    });
    expect(st.transactions).toHaveLength(6);
    expect(sum(st.transactions)).toBe(78620);
    expect(st.transactions[1]).toMatchObject({ amountCents: 150000, description: 'PIX RECEBIDO Cliente Ômega' });
    expect(st.transactions[5]!.memo).toBe('José & Filhos');
  });
  it('fatura de cartão (CCSTMTRS)', () => {
    const st = parseOfx(decodeStatementFile(fixtureBytes('fatura-cartao.ofx')));
    expect(st).toMatchObject({ kind: 'creditcard', bankId: null, accountId: '4111********1111', ledgerBalance: { amountCents: -79020 } });
    expect(st.transactions).toHaveLength(7);
    expect(sum(st.transactions)).toBe(-79020);
    const refund = st.transactions.find((t) => t.amountCents > 0)!;
    expect(refund).toMatchObject({ fitid: 'CC-0005', amountCents: 4500, description: 'ESTORNO RESTAURANTE SABOR', name: null });
  });
  it('rejeita arquivo sem transações', () => {
    expect(() => parseOfx('<html></html>')).toThrow(/OFX/);
    expect(() => parseOfx('<OFX><SIGNONMSGSRSV1></SIGNONMSGSRSV1></OFX>')).toThrow(/sem transações/);
  });
  it('datas e valores', () => {
    expect(parseOfxDate('20261005120000.000[-3:BRT]')).toBe('2026-10-05');
    expect(parseOfxDate('20261305')).toBeNull();
    expect(parseOfxAmount('-1.234,56')).toBe(-123456);
    expect(parseOfxAmount('+10.5')).toBe(1050);
    expect(parseOfxAmount('abc')).toBeNull();
  });
});
