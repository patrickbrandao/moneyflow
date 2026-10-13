import { describe, expect, it } from 'vitest';
import { formatCep, normalizeCep, normalizeUf } from '../src/address';
import { formatPixKey, guessPixKeyType, isValidPixKey, normalizePixKey } from '../src/pix';

describe('PIX', () => {
  it('normaliza como o banco grava', () => {
    expect(normalizePixKey('cpf', '529.982.247-25')).toBe('52998224725');
    expect(normalizePixKey('cnpj', '12.abc.345/01de-35')).toBe('12ABC34501DE35');
    expect(normalizePixKey('email', ' Fulano@Exemplo.COM ')).toBe('fulano@exemplo.com');
    expect(normalizePixKey('phone', '(11) 98765-4321')).toBe('+5511987654321');
    expect(normalizePixKey('phone', '+55 11 98765-4321')).toBe('+5511987654321');
    expect(normalizePixKey('evp', '123E4567-E89B-12D3-A456-426614174000')).toBe('123e4567-e89b-12d3-a456-426614174000');
  });
  it('valida por tipo', () => {
    expect(isValidPixKey('phone', '+5511987654321')).toBe(true);
    expect(isValidPixKey('phone', '+551198765432')).toBe(true);
    expect(isValidPixKey('phone', '+5501987654321')).toBe(false);
    expect(isValidPixKey('email', 'a@b.co')).toBe(true);
    expect(isValidPixKey('email', `${'a'.repeat(80)}@b.co`)).toBe(false);
    expect(isValidPixKey('cpf', '52998224724')).toBe(false);
    expect(isValidPixKey('evp', 'not-a-uuid')).toBe(false);
  });
  it('adivinha o tipo e formata telefone', () => {
    expect(guessPixKeyType('fulano@x.com')).toBe('email');
    expect(guessPixKeyType('529.982.247-25')).toBe('cpf');
    expect(guessPixKeyType('11222333000181')).toBe('cnpj');
    expect(formatPixKey('phone', '+5511987654321')).toBe('+55 (11) 98765-4321');
  });
  it('CNPJ alfanumérico: adivinha, normaliza e formata como o documento', () => {
    expect(guessPixKeyType('12.abc.345/01de-35')).toBe('cnpj');
    expect(guessPixKeyType('12ABC34501DE35')).toBe('cnpj');
    expect(guessPixKeyType('12ABC34501DE36')).toBeNull();
    expect(isValidPixKey('cnpj', normalizePixKey('cnpj', '12.abc.345/01de-35'))).toBe(true);
    expect(formatPixKey('cnpj', '12ABC34501DE35')).toBe('12.ABC.345/01DE-35');
    expect(formatPixKey('cnpj', '11222333000181')).toBe('11.222.333/0001-81');
    expect(formatPixKey('cpf', '52998224725')).toBe('529.982.247-25');
    // Valor fora do formato aparece cru.
    expect(formatPixKey('cnpj', 'XYZ')).toBe('XYZ');
  });
});

describe('CEP e UF', () => {
  it('normaliza', () => {
    expect(normalizeCep('01310-100')).toBe('01310100');
    expect(normalizeCep('0131010')).toBeNull();
    expect(formatCep('01310100')).toBe('01310-100');
    expect(normalizeUf(' sp ')).toBe('SP');
    expect(normalizeUf('XX')).toBeNull();
  });
});
