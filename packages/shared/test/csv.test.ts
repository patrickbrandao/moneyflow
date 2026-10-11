import { describe, expect, it } from 'vitest';
import { applyCsvMapping, type CsvMapping, detectDelimiter, parseAmount, parseCsv, parseDateWithFormat } from '../src/parsers/csv';
import { fixtureText } from './fixtures';

describe('parseCsv', () => {
  it('RFC 4180', () => {
    expect(parseCsv('a,"b,1","c ""x"""\r\n\r\n1,2,3\n"multi\nlinha",,\n', ',')).toEqual([
      ['a', 'b,1', 'c "x"'],
      ['1', '2', '3'],
      ['multi\nlinha', '', ''],
    ]);
    expect(parseCsv('x;y', ';')).toEqual([['x', 'y']]);
  });
  it('detecta o separador', () => {
    expect(detectDelimiter(fixtureText('extrato-itau.csv'))).toBe(';');
    expect(detectDelimiter(fixtureText('extrato-debito-credito.csv'))).toBe(',');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('a|b\n1|2')).toBe('|');
  });
});

describe('valores e datas', () => {
  it('parseAmount', () => {
    expect(parseAmount('1.234,56', ',')).toBe(123456);
    expect(parseAmount('-1.234,56', ',')).toBe(-123456);
    expect(parseAmount('R$ 1.234,56', ',')).toBe(123456);
    expect(parseAmount('-R$ 10,00', ',')).toBe(-1000);
    expect(parseAmount('(1.234,56)', ',')).toBe(-123456);
    expect(parseAmount('50,00 D', ',')).toBe(-5000);
    expect(parseAmount('50,00 C', ',')).toBe(5000);
    expect(parseAmount('1,234.56', '.')).toBe(123456);
    expect(parseAmount('-0.5', '.')).toBe(-50);
    expect(parseAmount('12.5', ',')).toBe(1250);
    expect(parseAmount('abc', ',')).toBeNull();
    expect(parseAmount('', ',')).toBeNull();
  });
  it('parseDateWithFormat', () => {
    expect(parseDateWithFormat('05/10/2026', 'dd/MM/yyyy')).toBe('2026-10-05');
    expect(parseDateWithFormat('5/10/26', 'dd/MM/yy')).toBe('2026-10-05');
    expect(parseDateWithFormat('2026-10-05', 'yyyy-MM-dd')).toBe('2026-10-05');
    expect(parseDateWithFormat('10/05/2026', 'MM/dd/yyyy')).toBe('2026-10-05');
    expect(parseDateWithFormat('05-10-2026', 'dd-MM-yyyy')).toBe('2026-10-05');
    expect(parseDateWithFormat('05.10.2026', 'dd.MM.yyyy')).toBe('2026-10-05');
    expect(parseDateWithFormat('20261005', 'yyyyMMdd')).toBe('2026-10-05');
    expect(parseDateWithFormat('05/10/2026 14:22:01', 'dd/MM/yyyy')).toBe('2026-10-05');
    expect(parseDateWithFormat('31/02/2026', 'dd/MM/yyyy')).toBeNull();
    expect(parseDateWithFormat('2026-10-05', 'dd/MM/yyyy')).toBeNull();
  });
});

describe('applyCsvMapping', () => {
  it('extrato com valor único e cabeçalho por nome (sem acento/maiúsculas)', () => {
    const mapping: CsvMapping = {
      hasHeader: true,
      skipRows: 0,
      dateFormat: 'dd/MM/yyyy',
      decimalSeparator: ',',
      columns: { date: 'Data', description: 'LANCAMENTO', amount: 'valor', balance: 'saldo' },
    };
    const result = applyCsvMapping(parseCsv(fixtureText('extrato-itau.csv'), ';'), mapping);
    expect(result.headers).toEqual(['data', 'lançamento', 'valor', 'saldo']);
    expect(result.errors).toEqual([{ row: 2, message: 'valor zero' }]);
    expect(result.lines).toHaveLength(6);
    expect(result.lines.reduce((s, l) => s + l.amountCents, 0)).toBe(7988);
    expect(result.lines[0]).toEqual({
      row: 3,
      postedOn: '2026-10-02',
      amountCents: 150000,
      description: 'PIX RECEBIDO MARIA',
      fitid: null,
      balanceCents: 250000,
      raw: { data: '02/10/2026', lançamento: 'PIX RECEBIDO MARIA', valor: '1.500,00', saldo: '2.500,00' },
    });
    expect(result.lines[2]!.description).toBe('COMPRA; PADARIA');
    expect(result.lines.at(-1)).toMatchObject({ amountCents: -1290, balanceCents: 107988 });
  });
  it('débito e crédito em colunas separadas, por índice', () => {
    const mapping: CsvMapping = {
      hasHeader: true,
      skipRows: 0,
      dateFormat: 'yyyy-MM-dd',
      decimalSeparator: '.',
      columns: { date: 0, description: 1, debit: 'débito', credit: 'Credito', fitid: 'documento' },
    };
    const result = applyCsvMapping(parseCsv(fixtureText('extrato-debito-credito.csv'), ','), mapping);
    expect(result.errors).toEqual([]);
    expect(result.lines.map((l) => l.amountCents)).toEqual([500000, -150000, -123456, 20050, -8990]);
    expect(result.lines.map((l) => l.fitid)).toEqual(['1001', '1002', '1003', '1004', '1005']);
    expect(result.lines[4]!.description).toBe('Loja "Boa Compra"');
  });
  it('erros por linha sem lançar; sem cabeçalho e com linhas a pular', () => {
    const rows = parseCsv('Banco Exemplo\nxx/10/2026;a;1,00\n01/10/2026;b;abc\n01/10/2026;c;2,00\n', ';');
    const result = applyCsvMapping(rows, {
      hasHeader: false,
      skipRows: 1,
      dateFormat: 'dd/MM/yyyy',
      decimalSeparator: ',',
      columns: { date: 0, description: 1, amount: 2 },
    });
    expect(result.headers).toBeNull();
    expect(result.errors.map((e) => e.row)).toEqual([2, 3]);
    expect(result.lines).toMatchObject([{ row: 4, amountCents: 200, raw: { '0': '01/10/2026' } }]);
  });
  it('coluna inexistente lança', () => {
    expect(() =>
      applyCsvMapping([['a', 'b']], {
        hasHeader: true,
        skipRows: 0,
        dateFormat: 'dd/MM/yyyy',
        decimalSeparator: ',',
        columns: { date: 'x', description: 'b', amount: 'a' },
      }),
    ).toThrow(/não encontrada/);
  });
});
