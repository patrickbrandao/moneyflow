import { describe, expect, it } from 'vitest';
import { parseOfxStatements } from '../src/parsers/ofx';
import { parseXml, XML_MAX_DEPTH, XML_MAX_NODES, XML_TOO_DEEP, XML_TOO_MANY_NODES } from '../src/parsers/xml';

/*
 * Limites dos parsers OFX e XML (tarefa 052): profundidade e número de elementos, e o fechamento sem
 * par procurado de trás para frente sem alocar. Um arquivo montado é recusado em pouco tempo.
 */

const elapsed = (fn: () => unknown) => {
  const start = performance.now();
  try {
    fn();
  } catch {
    // o erro é conferido nos casos abaixo; aqui só o tempo
  }
  return performance.now() - start;
};

describe('limites do parser OFX', () => {
  it('recusa aninhamento acima do limite', () => {
    const body = `<OFX>${'<A>'.repeat(XML_MAX_DEPTH + 1)}`;
    expect(() => parseOfxStatements(body)).toThrow(XML_TOO_DEEP);
  });

  it('aceita até o limite de profundidade', () => {
    const body = `<OFX>${'<A>'.repeat(XML_MAX_DEPTH - 1)}`;
    expect(() => parseOfxStatements(body)).toThrow(/sem transações/);
  });

  // O teto de tempo aqui é folgado de propósito (máquina carregada); o rigor fica no caso de 20 MB.
  it('uma massa de fechamentos sem par termina rápido', () => {
    const body = `<OFX>${'<A>'.repeat(XML_MAX_DEPTH - 1)}${'</B>'.repeat(1_000_000)}`;
    expect(() => parseOfxStatements(body)).toThrow(/sem transações/);
    expect(elapsed(() => parseOfxStatements(body))).toBeLessThan(10_000);
  });

  it('recusa elementos demais', () => {
    const body = `<OFX>${'<A>x'.repeat(XML_MAX_NODES + 1)}`;
    expect(() => parseOfxStatements(body)).toThrow(XML_TOO_MANY_NODES);
  });

  it('o arquivo patológico de 20 MB é recusado em menos de 1 s', () => {
    const body = `<OFX>${'<A>'.repeat(3_300_000)}${'</B>'.repeat(2_600_000)}`;
    expect(elapsed(() => parseOfxStatements(body))).toBeLessThan(1000);
    expect(() => parseOfxStatements(body)).toThrow(XML_TOO_DEEP);
  });
});

describe('limites do parser XML', () => {
  it('recusa aninhamento acima do limite', () => {
    expect(() => parseXml('<a>'.repeat(XML_MAX_DEPTH + 1))).toThrow(XML_TOO_DEEP);
    expect(parseXml('<a>'.repeat(XML_MAX_DEPTH)).name).toBe('a');
  });

  it('uma massa de fechamentos sem par termina rápido', () => {
    const body = `<a>${'<b>'.repeat(XML_MAX_DEPTH - 1)}${'</c>'.repeat(1_000_000)}`;
    expect(parseXml(body).name).toBe('a');
    expect(elapsed(() => parseXml(body))).toBeLessThan(10_000);
  });

  it('recusa elementos demais', () => {
    expect(() => parseXml(`<a>${'<b/>'.repeat(XML_MAX_NODES)}</a>`)).toThrow(XML_TOO_MANY_NODES);
  });

  it('o arquivo patológico de 20 MB é recusado em menos de 1 s', () => {
    const body = `${'<a>'.repeat(3_300_000)}${'</b>'.repeat(2_600_000)}`;
    expect(elapsed(() => parseXml(body))).toBeLessThan(1000);
    expect(() => parseXml(body)).toThrow(XML_TOO_DEEP);
  });
});
