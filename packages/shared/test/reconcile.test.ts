import { describe, expect, it } from 'vitest';
import {
  type ContractInstallmentRow,
  type ContractTerms,
  contractMatch,
  descriptionSimilarity,
  inContractWindow,
  type MatchCandidate,
  normalizeDescription,
  normalizeDescriptionForDedup,
  pickMatch,
  scoreCandidate,
  splitSettlement,
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

/* ---------------- parcelas de contrato (spec 033) ---------------- */

const terms = (over: Partial<ContractTerms> = {}): ContractTerms => ({
  lateFeePercent: 2,
  interestMonthPercent: 1,
  earlyDiscountPercent: 5,
  toleranceCents: 0,
  matchWindowDays: 15,
  ...over,
});
// Aluguel de R$ 2.000,00 com vencimento no dia 10.
const rent = (dueDate: string, over: Partial<ContractInstallmentRow> = {}): ContractInstallmentRow => ({
  titleId: `t-${dueDate}`,
  contractId: 'c1',
  contractName: 'Aluguel Centro',
  installment: Number(dueDate.slice(5, 7)),
  installmentsCount: 12,
  description: `Aluguel Centro ${dueDate.slice(5, 7)}/12`,
  entityName: 'Imobiliária Alfa',
  dueDate,
  amountCents: 200000,
  openCents: 200000,
  plannedAccountId: 'acc',
  autoSettle: false,
  terms: terms(),
  ...over,
});
const pay = (postedOn: string, amountCents: number, description = 'PIX ENVIADO IMOBILIARIA ALFA') => ({
  postedOn,
  amountCents,
  description,
  accountId: 'acc',
});

describe('splitSettlement', () => {
  const inst = { dueDate: '2026-03-10', amountCents: 200000, openCents: 200000 };
  it('exato em qualquer data', () => {
    expect(splitSettlement(200000, inst, terms(), '2026-03-20')).toMatchObject({ kind: 'exact', amountCents: 200000, days: 10 });
  });
  it('com encargos: multa até o máximo e o resto em juros', () => {
    // 10 dias de atraso: multa 2% = 4.000,00 → 40000; juros 1% a.m. × 10/30 = 666,67 → 667.
    const split = splitSettlement(200000 + 4000 + 667, inst, terms(), '2026-03-20')!;
    expect(split).toEqual({ kind: 'charges', amountCents: 200000, fineCents: 4000, interestCents: 667, discountCents: 0, days: 10 });
    // Só a multa paga: tudo na multa.
    expect(splitSettlement(202000, inst, terms(), '2026-03-20')).toMatchObject({ kind: 'charges', fineCents: 2000, interestCents: 0 });
    // Acima do máximo: não bate.
    expect(splitSettlement(204668, inst, terms(), '2026-03-20')).toBeNull();
    // Acima do saldo antes do vencimento: não é encargo.
    expect(splitSettlement(202000, inst, terms(), '2026-03-05')).toBeNull();
  });
  it('com desconto até o vencimento', () => {
    expect(splitSettlement(190000, inst, terms(), '2026-03-08')).toEqual({
      kind: 'discount',
      amountCents: 200000,
      fineCents: 0,
      interestCents: 0,
      discountCents: 10000,
      days: -2,
    });
    // Depois do vencimento, a falta vira parcial.
    expect(splitSettlement(190000, inst, terms(), '2026-03-11')).toMatchObject({ kind: 'partial', amountCents: 190000 });
  });
  it('dentro da tolerância em qualquer data, com o teto de 10% da parcela', () => {
    const noCharges = terms({ lateFeePercent: null, interestMonthPercent: null, earlyDiscountPercent: null, toleranceCents: 350 });
    expect(splitSettlement(200350, inst, noCharges, '2026-03-02')).toMatchObject({ kind: 'tolerance', interestCents: 350 });
    expect(splitSettlement(199700, inst, noCharges, '2026-03-25')).toMatchObject({ kind: 'tolerance', discountCents: 300 });
    expect(splitSettlement(200351, inst, noCharges, '2026-03-02')).toBeNull();
    const huge = terms({ lateFeePercent: null, interestMonthPercent: null, earlyDiscountPercent: null, toleranceCents: 999999 });
    expect(splitSettlement(220000, inst, huge, '2026-03-02')).toMatchObject({ kind: 'tolerance' });
    expect(splitSettlement(220001, inst, huge, '2026-03-02')).toBeNull();
  });
  it('parcial: menor que o saldo, fora dos outros casos', () => {
    expect(splitSettlement(50000, inst, terms(), '2026-03-10')).toMatchObject({ kind: 'partial', amountCents: 50000, discountCents: 0 });
  });
});

describe('inContractWindow', () => {
  it('mesmo mês do vencimento ou a janela, o que for mais largo', () => {
    expect(inContractWindow('2026-03-31', '2026-03-01', 0)).toBe(true);
    expect(inContractWindow('2026-04-14', '2026-03-31', 15)).toBe(true);
    expect(inContractWindow('2026-04-16', '2026-03-31', 15)).toBe(false);
    expect(inContractWindow('2026-02-28', '2026-03-01', 0)).toBe(false);
  });
});

describe('contractMatch e o desempate', () => {
  const candidatesFor = (line: ReturnType<typeof pay>, rows: ContractInstallmentRow[]) =>
    rows.map((r) => contractMatch(line, r)).filter((c): c is MatchCandidate => c !== null);

  it('fora da janela não é candidato', () => {
    expect(contractMatch(pay('2026-05-01', -200000), rent('2026-03-10'))).toBeNull();
  });
  it('aluguel pago 10 dias atrasado com multa e juros é sugerido com a repartição', () => {
    const line = pay('2026-03-20', -204667);
    const pick = pickMatch(line, candidatesFor(line, [rent('2026-03-10')]));
    expect(pick?.status).toBe('suggested');
    expect(pick?.candidate.contract?.split).toMatchObject({ kind: 'charges', fineCents: 4000, interestCents: 667, days: 10 });
  });
  it('dois meses iguais: o do mesmo mês da linha primeiro', () => {
    const line = pay('2026-04-08', -200000);
    const pick = pickMatch(line, candidatesFor(line, [rent('2026-03-10'), rent('2026-04-10')]));
    expect(pick?.candidate.id).toBe('t-2026-04-10');
  });
  it('o do mês já pago: o atraso paga a mais antiga em aberto da janela', () => {
    // Duas parcelas de março em aberto (semanal), abril já pago (fora da lista): a de 05/04 paga a mais velha.
    const line = pay('2026-04-05', -200000);
    const pick = pickMatch(line, candidatesFor(line, [rent('2026-03-28'), rent('2026-03-25'), rent('2026-05-01')]));
    expect(pick?.candidate.id).toBe('t-2026-03-25');
  });
  it('parcela já sugerida para outra linha não volta', () => {
    const line = pay('2026-04-08', -200000);
    const pick = pickMatch(line, candidatesFor(line, [rent('2026-03-28'), rent('2026-04-10')]), new Set(['t-2026-04-10']));
    expect(pick?.candidate.id).toBe('t-2026-03-28');
  });
  it('parcial só quando nenhuma outra parcela do contrato casa', () => {
    const line = pay('2026-04-08', -100000);
    expect(pickMatch(line, candidatesFor(line, [rent('2026-04-10')]))?.candidate.contract?.split.kind).toBe('partial');
    const exactOther = rent('2026-03-28', { openCents: 100000 });
    expect(pickMatch(line, candidatesFor(line, [rent('2026-04-10'), exactOther]))?.candidate.id).toBe('t-2026-03-28');
  });
  it('baixa sem confirmação: único candidato, na conta prevista, sem parcial nem só tolerância', () => {
    const auto = (over: Partial<ContractInstallmentRow>, amount = -200000) => {
      const line = pay('2026-04-10', amount);
      return pickMatch(line, candidatesFor(line, [rent('2026-04-10', { autoSettle: true, ...over })]))?.autoSettle ?? false;
    };
    expect(auto({})).toBe(true);
    expect(auto({ plannedAccountId: 'other' })).toBe(false);
    expect(auto({ autoSettle: false })).toBe(false);
    expect(auto({}, -100000)).toBe(false); // parcial
    expect(auto({ terms: terms({ earlyDiscountPercent: null, toleranceCents: 500 }) }, -199800)).toBe(false); // tolerância
    // Com outro candidato (um movimento igual), não baixa sozinho.
    const line = pay('2026-04-10', -200000);
    const both = [
      ...candidatesFor(line, [rent('2026-04-10', { autoSettle: true })]),
      movement({ amountCents: -200000, date: '2026-04-10' }),
    ];
    expect(pickMatch(line, both)?.autoSettle).toBeUndefined();
  });
  it('a mesma parcela pela regra de sempre (valor exato) e pela do contrato conta uma vez', () => {
    const line = pay('2026-04-10', -200000);
    const generic: MatchCandidate = { kind: 'title', id: 't-2026-04-10', date: '2026-04-10', amountCents: -200000, description: 'x' };
    const pick = pickMatch(line, [generic, ...candidatesFor(line, [rent('2026-04-10', { autoSettle: true })])]);
    expect(pick?.candidate.contract).toBeDefined();
    expect(pick?.autoSettle).toBe(true);
  });
  it('entre contratos, a conta prevista igual à da linha ganha', () => {
    const line = pay('2026-04-10', -200000, 'PIX ENVIADO');
    const a = rent('2026-04-10', { contractId: 'a', titleId: 'a', plannedAccountId: 'outra' });
    const b = rent('2026-04-10', { contractId: 'b', titleId: 'b' });
    expect(pickMatch(line, candidatesFor(line, [a, b]))?.candidate.id).toBe('b');
  });
});
