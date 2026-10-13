import { describe, expect, it } from 'vitest';
import {
  descriptionSimilarity,
  type MatchCandidate,
  normalizeDescription,
  normalizeDescriptionForDedup,
  pickMatch,
  scoreCandidate,
} from '../src/reconcile';

const line = { postedOn: '2026-10-10', amountCents: -15237, description: 'PAGTO BOLETO ENEL Energia 12345678 05/10' };
const movement = (over: Partial<MatchCandidate> = {}): MatchCandidate => ({
  kind: 'movement',
  id: 'm1',
  date: '2026-10-10',
  amountCents: -15237,
  description: 'Conta de energia',
  entityName: 'Enel',
  ...over,
});

describe('normalizeDescription', () => {
  it('limpa acentos, pontuação, números longos e datas', () => {
    expect(normalizeDescription('  PIX Enviado - João  da Silva 05/10 123456789 nº 12 ')).toBe('pix enviado joao da silva n 12');
  });
  it('descarta o CNPJ numérico ou alfanumérico (com DV válido), com ou sem pontuação', () => {
    expect(normalizeDescription('PIX ENVIADO 12.ABC.345/01DE-35 FORNECEDOR')).toBe('pix enviado fornecedor');
    expect(normalizeDescription('PIX ENVIADO 12abc34501de35 FORNECEDOR')).toBe('pix enviado fornecedor');
    expect(normalizeDescription('TED 12.345.678/0001-95 Móveis')).toBe('ted moveis');
    // DV errado: não é CNPJ, fica (sem a pontuação).
    expect(normalizeDescription('PIX 12abc34501de36 X')).toBe('pix 12abc34501de36 x');
    // O casamento passa a ignorar o CNPJ: a linha com e sem ele casa igual.
    expect(descriptionSimilarity('PIX ENVIADO 12ABC34501DE35 FORNECEDOR ALFA', 'fornecedor alfa pix enviado')).toBe(1);
  });
  it('a normalização do dedup é congelada (spec 009): não descarta o CNPJ alfanumérico', () => {
    expect(normalizeDescriptionForDedup('PIX ENVIADO 12.ABC.345/01DE-35 FORNECEDOR ALFA')).toBe(
      'pix enviado 12 abc 345 01de 35 fornecedor alfa',
    );
    expect(normalizeDescriptionForDedup('PIX RECEBIDO 12abc34501de35 Cliente Ação')).toBe('pix recebido 12abc34501de35 cliente acao');
    expect(normalizeDescriptionForDedup('  PIX Enviado - João  da Silva 05/10 123456789 nº 12 ')).toBe('pix enviado joao da silva n 12');
  });
  it('similaridade por tokens da linha', () => {
    expect(descriptionSimilarity('PAGTO ENEL ENERGIA', 'energia enel')).toBeCloseTo(2 / 3);
    expect(descriptionSimilarity('12 34', 'x')).toBe(0);
  });
});

describe('scoreCandidate', () => {
  it('exige valor igual e até 3 dias', () => {
    expect(scoreCandidate(line, movement({ amountCents: -15238 }))).toBeNull();
    expect(scoreCandidate(line, movement({ date: '2026-10-14' }))).toBeNull();
    expect(scoreCandidate(line, movement({ date: '2026-10-07' }))).not.toBeNull();
  });
  it('60 base, −10 por dia, até +40 pelo texto', () => {
    // tokens da linha: pagto, boleto, enel, energia → enel e energia presentes (0,5).
    expect(scoreCandidate(line, movement())).toBe(80);
    expect(scoreCandidate(line, movement({ date: '2026-10-12' }))).toBe(60);
    expect(scoreCandidate(line, movement({ description: 'x', entityName: null }))).toBe(60);
  });
});

describe('pickMatch', () => {
  it('movimento único e mesma data → matched', () => {
    expect(pickMatch(line, [movement()])).toMatchObject({ status: 'matched', score: 80, candidate: { id: 'm1' } });
  });
  it('outra data sem texto parecido → suggested', () => {
    expect(pickMatch(line, [movement({ date: '2026-10-11', description: 'x', entityName: null })])?.status).toBe('suggested');
  });
  it('dois movimentos compatíveis → suggested', () => {
    const r = pickMatch(line, [movement(), movement({ id: 'm2', description: 'outro' })]);
    expect(r).toMatchObject({ status: 'suggested', candidate: { id: 'm1' } });
  });
  it('título é sempre suggested; empate prefere movimento', () => {
    const title: MatchCandidate = { ...movement(), kind: 'title', id: 't1' };
    expect(pickMatch(line, [title])?.status).toBe('suggested');
    expect(pickMatch(line, [title, movement()])?.candidate.id).toBe('m1');
  });
  it('empate de score prefere a menor diferença de dias', () => {
    const near = movement({ id: 'near', date: '2026-10-11', description: 'x', entityName: null }); // 50
    const far = movement({ id: 'far', date: '2026-10-12', description: 'conta energia enel', entityName: null }); // 40+...
    const r = pickMatch(line, [far, near]);
    expect(r?.candidate.id).toBe('far'); // 60 > 50
    const tieA = movement({ id: 'a', date: '2026-10-11', description: 'x', entityName: null });
    const tieB = movement({ id: 'b', date: '2026-10-09', description: 'x', entityName: null });
    expect(pickMatch({ ...line }, [tieB, tieA])?.candidate.id).toBe('b');
  });
  it('ignora usados e sem candidatos devolve null', () => {
    expect(pickMatch(line, [movement()], new Set(['m1']))).toBeNull();
    expect(pickMatch(line, [])).toBeNull();
  });
  it('item de cartão com texto parecido → matched', () => {
    const item: MatchCandidate = { kind: 'card_item', id: 'c1', date: '2026-10-12', amountCents: -15237, description: 'ENEL ENERGIA' };
    expect(pickMatch(line, [item])?.status).toBe('matched');
  });
});
