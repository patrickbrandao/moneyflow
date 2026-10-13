import { describe, expect, it } from 'vitest';
import { isValidNfeAccessKey, nfeAccessKeyDv, normalizeNfeAccessKey, parseNfeXml } from '../src/parsers/nfe';
import { fixtureText } from './fixtures';

// Conferida com is_valid_nfe_access_key do banco.
const KEY = '35261012345678000195550010000123451876543219';

describe('NF-e', () => {
  it('lê o nfeProc', () => {
    const nfe = parseNfeXml(fixtureText('nfe-exemplo.xml'));
    expect(nfe).toMatchObject({
      accessKey: KEY,
      number: 12345,
      series: 1,
      model: '55',
      issuedAt: '2026-10-05T14:30:00-03:00',
      issuer: {
        document: '12345678000195',
        name: 'Móveis Exemplo & Cia Ltda',
        tradeName: 'Móveis Exemplo',
        stateRegistration: '123456789110',
        address: {
          street: 'Rua das Flores',
          number: '100',
          complement: 'Sala 2',
          district: 'Centro',
          city: 'São Paulo',
          state: 'SP',
          postalCode: '01001000',
        },
      },
      recipient: { document: '12345678909', name: 'Fulano de Tal' },
      totalCents: 43309,
      paymentDueDate: '2026-11-10',
    });
    expect(nfe.items).toEqual([
      {
        itemNumber: 1,
        productCode: 'P001',
        description: 'Cadeira de escritório',
        ncm: '94013000',
        cfop: '5102',
        unit: 'UN',
        quantity: 2,
        unitPriceCents: 15000,
        totalCents: 30000,
      },
      {
        itemNumber: 2,
        productCode: 'P002',
        description: 'Mesa dobrável',
        ncm: '94036000',
        cfop: '5102',
        unit: 'UN',
        quantity: 1,
        unitPriceCents: 8990,
        totalCents: 8990,
      },
      {
        itemNumber: 3,
        productCode: 'P003',
        description: 'Cabo de rede <Cat6> (metro)',
        ncm: '85444900',
        cfop: '5102',
        unit: 'M',
        quantity: 3.5,
        unitPriceCents: 1234,
        totalCents: 4319,
      },
    ]);
    expect(nfe.duplicates).toEqual([
      { number: '001', dueDate: '2026-11-10', amountCents: 21655 },
      { number: '002', dueDate: '2026-12-10', amountCents: 21654 },
    ]);
    expect(nfe.items.reduce((s, i) => s + i.totalCents, 0)).toBe(nfe.totalCents);
  });
  it('lê só a NFe, com prefixo de namespace', () => {
    const xml = fixtureText('nfe-exemplo.xml');
    const onlyNfe = xml.slice(xml.indexOf('<NFe'), xml.indexOf('</NFe>') + 6).replace(/<(\/?)([A-Za-z])/g, '<$1nfe:$2');
    const nfe = parseNfeXml(`<?xml version="1.0"?>${onlyNfe.replace('<nfe:NFe xmlns=', '<nfe:NFe xmlns:nfe=')}`);
    expect(nfe).toMatchObject({ accessKey: KEY, totalCents: 43309, issuer: { document: '12345678000195' } });
    expect(nfe.items).toHaveLength(3);
  });
  it('usa a chave do protocolo quando o Id falta', () => {
    const xml = fixtureText('nfe-exemplo.xml').replace(/Id="NFe\d+"/, '');
    expect(parseNfeXml(xml).accessKey).toBe(KEY);
  });
  it('rejeita chave inválida e XML que não é NF-e', () => {
    expect(isValidNfeAccessKey(KEY)).toBe(true);
    expect(isValidNfeAccessKey(`${KEY.slice(0, 43)}0`)).toBe(false);
    expect(isValidNfeAccessKey('123')).toBe(false);
    const bad = fixtureText('nfe-exemplo.xml').replaceAll(KEY, `${KEY.slice(0, 43)}0`);
    expect(() => parseNfeXml(bad)).toThrow(/Chave de acesso/);
    expect(() => parseNfeXml('<OFX><a>1</a></OFX>')).toThrow(/não é uma NF-e/);
    expect(() => parseNfeXml('texto')).toThrow(/XML/);
  });
});

// NT 2025.001: o CNPJ do emitente (posições 7–20) pode ser alfanumérico; DV com ASCII − 48.
const ALFA_KEY = '35261012ABC34501DE35550010000123461876543224';

describe('NF-e com CNPJ alfanumérico', () => {
  it('valida a chave como is_valid_nfe_access_key (0036)', () => {
    expect(nfeAccessKeyDv(ALFA_KEY.slice(0, 43))).toBe(4);
    expect(isValidNfeAccessKey(ALFA_KEY)).toBe(true);
    expect(isValidNfeAccessKey(`${ALFA_KEY.slice(0, 43)}0`)).toBe(false);
    // Já normalizada: minúsculas não passam; normalizar resolve.
    expect(isValidNfeAccessKey(ALFA_KEY.toLowerCase())).toBe(false);
    expect(isValidNfeAccessKey(normalizeNfeAccessKey(` ${ALFA_KEY.toLowerCase()} `))).toBe(true);
    // Letras só nas posições 7–20.
    const letterOutside = `A${ALFA_KEY.slice(1, 43)}`;
    expect(isValidNfeAccessKey(`${letterOutside}${nfeAccessKeyDv(letterOutside)}`)).toBe(false);
    const letterInDv = `${ALFA_KEY.slice(0, 43)}A`;
    expect(isValidNfeAccessKey(letterInDv)).toBe(false);
  });
  it('lê emitente, destinatário e chave alfanuméricos', () => {
    const nfe = parseNfeXml(fixtureText('nfe-cnpj-alfanumerico.xml'));
    expect(nfe).toMatchObject({
      accessKey: ALFA_KEY,
      number: 12346,
      totalCents: 25000,
      issuer: { document: '12ABC34501DE35', name: 'Alfa Exemplo Comércio Ltda' },
      recipient: { document: 'A1B2C3D4000193' },
      paymentDueDate: '2026-11-06',
    });
  });
  it('aceita o Id e o chNFe em minúsculas', () => {
    const xml = fixtureText('nfe-cnpj-alfanumerico.xml').replaceAll(ALFA_KEY, ALFA_KEY.toLowerCase());
    expect(parseNfeXml(xml).accessKey).toBe(ALFA_KEY);
    const noId = fixtureText('nfe-cnpj-alfanumerico.xml').replace(/Id="NFe[0-9A-Z]+"/, '');
    expect(parseNfeXml(noId).accessKey).toBe(ALFA_KEY);
  });
});
