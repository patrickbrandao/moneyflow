import { describe, expect, it } from 'vitest';
import { cnpjCheckDigits, cpfCheckDigits, formatCnpj, formatCpf, isValidCnpj, isValidCpf, normalizeDocument } from '../src/documents';

describe('CPF', () => {
  it('valida dígitos verificadores', () => {
    expect(isValidCpf('52998224725')).toBe(true);
    expect(isValidCpf('52998224724')).toBe(false);
    expect(isValidCpf(`123456789${cpfCheckDigits('123456789')}`)).toBe(true);
  });
  it('rejeita sequências e valores não normalizados', () => {
    expect(isValidCpf('11111111111')).toBe(false);
    expect(isValidCpf('529.982.247-25')).toBe(false);
    expect(isValidCpf(normalizeDocument('529.982.247-25'))).toBe(true);
  });
  it('formata', () => expect(formatCpf('52998224725')).toBe('529.982.247-25'));
});

describe('CNPJ', () => {
  it('valida CNPJ numérico', () => {
    expect(isValidCnpj('11222333000181')).toBe(true);
    expect(isValidCnpj('11222333000182')).toBe(false);
    expect(isValidCnpj('00000000000000')).toBe(false);
  });
  it('valida CNPJ alfanumérico (exemplo da Receita: 12.ABC.345/01DE-35)', () => {
    expect(normalizeDocument('12.abc.345/01de-35')).toBe('12ABC34501DE35');
    expect(isValidCnpj('12ABC34501DE35')).toBe(true);
    expect(isValidCnpj('12ABC34501DE36')).toBe(false);
    expect(cnpjCheckDigits('12ABC34501DE')).toBe('35');
  });
  it('exige DVs numéricos e letras maiúsculas', () => {
    expect(isValidCnpj('12abc34501de35')).toBe(false);
    expect(isValidCnpj('12ABC34501DEAB')).toBe(false);
  });
  it('formata', () => expect(formatCnpj('12ABC34501DE35')).toBe('12.ABC.345/01DE-35'));
});
