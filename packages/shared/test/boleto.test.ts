import { describe, expect, it } from 'vitest';
import {
  barcodeToDigitableLine,
  digitableLineToBarcode,
  dueDateFromFactor,
  formatDigitableLine,
  isValidBoletoBarcode,
  parseBoleto,
} from '../src/boleto';

// Códigos fictícios, conferidos com is_valid_boleto_barcode do banco.
const ITAU_BARCODE = '34191160500001234561790010104351004791020150';
const ITAU_LINE = '34191.79001 10104.351001 47910.201509 1 16050000123456';
const BB_LINE = '00190000090234567890400000012179316210000008990';
const ENERGY_LINE = '83620000001-3 52370048202-0 61020000001-2 23456789012-9';
const ENERGY_BARCODE = '83620000001523700482026102000000123456789012';
const GOV_LINE = '858500000002459000011237456789012341567890123457';
const TODAY = '2026-10-11';

describe('boleto bancário', () => {
  it('lê a linha digitável formatada', () => {
    const r = parseBoleto(ITAU_LINE, TODAY);
    expect(r).toEqual({
      ok: true,
      kind: 'bank',
      barcode: ITAU_BARCODE,
      digitableLine: ITAU_LINE,
      bankCode: '341',
      amountCents: 123456,
      dueDate: '2026-10-20',
    });
  });
  it('lê o código de barras e a linha só com dígitos', () => {
    const fromBarcode = parseBoleto(ITAU_BARCODE, TODAY);
    expect(fromBarcode.ok && fromBarcode.digitableLine).toBe(ITAU_LINE);
    const bb = parseBoleto(BB_LINE, TODAY);
    expect(bb).toMatchObject({ ok: true, bankCode: '001', amountCents: 8990, dueDate: '2026-11-05' });
  });
  it('escolhe o ciclo do fator mais próximo de hoje', () => {
    expect(dueDateFromFactor(1000, '2025-03-01')).toBe('2025-02-22');
    expect(dueDateFromFactor(1000, '2000-07-01')).toBe('2000-07-03');
    expect(dueDateFromFactor(9999, '2025-01-01')).toBe('2025-02-21');
    expect(dueDateFromFactor(0, TODAY)).toBeNull();
    const old = parseBoleto(ITAU_BARCODE, '2002-01-01');
    expect(old.ok && old.dueDate).toBe('2002-02-28');
  });
  it('valor zero e fator zero viram null', () => {
    const body = `3419${'0000'}${'0'.repeat(10)}1790010104351004791020150`;
    const code = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((dv) => body.slice(0, 4) + dv + body.slice(4)).find(isValidBoletoBarcode)!;
    expect(parseBoleto(code, TODAY)).toMatchObject({ ok: true, amountCents: null, dueDate: null });
  });
  it('rejeita DV de campo, DV geral e tamanho', () => {
    expect(parseBoleto('34191.79002 10104.351001 47910.201509 1 16050000123456')).toMatchObject({
      ok: false,
      error: expect.stringContaining('campo 1'),
    });
    expect(parseBoleto('34191.79001 10104.351002 47910.201509 1 16050000123456')).toMatchObject({
      ok: false,
      error: expect.stringContaining('campo 2'),
    });
    expect(parseBoleto('34191.79001 10104.351001 47910.201508 1 16050000123456')).toMatchObject({
      ok: false,
      error: expect.stringContaining('campo 3'),
    });
    expect(parseBoleto('34191.79001 10104.351001 47910.201509 2 16050000123456')).toMatchObject({
      ok: false,
      error: expect.stringContaining('geral'),
    });
    expect(parseBoleto(`${ITAU_BARCODE.slice(0, 4)}2${ITAU_BARCODE.slice(5)}`).ok).toBe(false);
    expect(parseBoleto('3419179001').ok).toBe(false);
    expect(parseBoleto('abc').ok).toBe(false);
    expect(parseBoleto('').ok).toBe(false);
  });
});

describe('boleto de convênio', () => {
  it('lê energia (módulo 10, valor efetivo)', () => {
    expect(parseBoleto(ENERGY_LINE, TODAY)).toEqual({
      ok: true,
      kind: 'utility',
      barcode: ENERGY_BARCODE,
      digitableLine: ENERGY_LINE,
      bankCode: null,
      amountCents: 15237,
      dueDate: null,
    });
    expect(parseBoleto(ENERGY_BARCODE, TODAY).ok).toBe(true);
  });
  it('lê órgão público (módulo 11)', () => {
    expect(parseBoleto(GOV_LINE, TODAY)).toMatchObject({ ok: true, kind: 'utility', amountCents: 4590 });
  });
  it('rejeita DV de bloco e DV geral', () => {
    expect(parseBoleto(ENERGY_LINE.replace('-3 ', '-4 '))).toMatchObject({ ok: false, error: expect.stringContaining('bloco 1') });
    const wrongGeneral = `${ENERGY_BARCODE.slice(0, 3)}9${ENERGY_BARCODE.slice(4)}`;
    expect(parseBoleto(wrongGeneral).ok).toBe(false);
    expect(parseBoleto(`1${GOV_LINE.slice(1)}`).ok).toBe(false);
  });
});

describe('conversões', () => {
  it('linha ↔ código de barras', () => {
    expect(digitableLineToBarcode(ITAU_LINE)).toBe(ITAU_BARCODE);
    expect(barcodeToDigitableLine(ITAU_BARCODE)).toBe(ITAU_LINE);
    expect(barcodeToDigitableLine(ENERGY_BARCODE)).toBe(ENERGY_LINE);
    expect(digitableLineToBarcode('123')).toBeNull();
    expect(formatDigitableLine(BB_LINE)).toBe('00190.00009 02345.678904 00000.012179 3 16210000008990');
  });
  it('mesma regra do banco', () => {
    expect(isValidBoletoBarcode(ITAU_BARCODE)).toBe(true);
    expect(isValidBoletoBarcode(ENERGY_BARCODE)).toBe(true);
    expect(isValidBoletoBarcode(`${ITAU_BARCODE.slice(0, 43)}1`)).toBe(false);
    expect(isValidBoletoBarcode('8'.repeat(2))).toBe(false);
  });
});
