import { describe, expect, it } from 'vitest';
import {
  contractAmendmentInput,
  contractCreateInput,
  cycleEnd,
  diffLines,
  diffStats,
  occurrencePeriodEnd,
  periodicityCalendar,
  proratedAmount,
  readjustedTotal,
  readjustmentDateIn,
  stripInstallmentSuffix,
  termMonths,
} from '../src';

describe('contratos: vigência, rescisão e reajuste (specs 020 e 034)', () => {
  it('fim da vigência é o dia anterior ao mesmo dia, meses depois', () => {
    expect(cycleEnd('2025-03-01', 12)).toBe('2026-02-28');
    expect(cycleEnd('2024-03-01', 12)).toBe('2025-02-28');
    expect(cycleEnd('2025-01-15', 1)).toBe('2025-02-14');
    expect(cycleEnd('2025-01-31', 1)).toBe('2025-02-28');
    expect(cycleEnd('2025-03-31', 1)).toBe('2025-04-30');
  });

  it('o prazo da vigência em meses, para a renovação automática repetir', () => {
    expect(termMonths('2025-03-01', '2026-02-28')).toBe(12);
    expect(termMonths('2025-01-15', '2025-02-14')).toBe(1);
    expect(termMonths('2025-01-31', '2025-02-28')).toBe(1);
    expect(termMonths('2025-03-01', '2027-02-28')).toBe(24);
    expect(termMonths('2025-03-01', '2025-03-10')).toBe(1);
    for (const [start, months] of [
      ['2025-03-01', 12],
      ['2024-02-29', 12],
      ['2025-07-15', 6],
    ] as const)
      expect(termMonths(start, cycleEnd(start, months))).toBe(months);
  });

  it('periodicidade lida do PDF vira o calendário da série', () => {
    expect(periodicityCalendar('monthly')).toEqual({ frequency: 'monthly', intervalCount: 1 });
    expect(periodicityCalendar('quarterly')).toEqual({ frequency: 'monthly', intervalCount: 3 });
    expect(periodicityCalendar('semiannual')).toEqual({ frequency: 'monthly', intervalCount: 6 });
    expect(periodicityCalendar('annual')).toEqual({ frequency: 'yearly', intervalCount: 1 });
    expect(periodicityCalendar('single')).toBeNull();
  });

  it('período da ocorrência e o proporcional da rescisão', () => {
    expect(occurrencePeriodEnd('2025-03-01', { frequency: 'monthly', intervalCount: 1 })).toBe('2025-03-31');
    expect(occurrencePeriodEnd('2025-03-01', { frequency: 'monthly', intervalCount: 3 })).toBe('2025-05-31');
    expect(occurrencePeriodEnd('2025-03-01', { frequency: 'yearly', intervalCount: 1 })).toBe('2026-02-28');
    expect(occurrencePeriodEnd('2025-03-03', { frequency: 'weekly', intervalCount: 1 })).toBe('2025-03-09');
    expect(proratedAmount(31_000, '2025-03-01', '2025-03-31', '2025-03-10')).toBe(10_000);
    expect(proratedAmount(31_000, '2025-03-01', '2025-03-31', '2025-03-31')).toBe(31_000);
    expect(proratedAmount(31_000, '2025-03-01', '2025-03-31', '2025-02-28')).toBe(0);
  });

  it('reajuste em % sobre o valor', () => {
    expect(readjustedTotal(500_000, 4.5)).toBe(522_500);
    expect(readjustedTotal(6_000_001, 4.5)).toBe(6_270_001);
  });

  it('data-base do reajuste: aniversário ou a informada, só depois do início', () => {
    expect(readjustmentDateIn(2025, '2025-03-01', null)).toBeNull();
    expect(readjustmentDateIn(2026, '2025-03-01', null)).toBe('2026-03-01');
    expect(readjustmentDateIn(2026, '2025-03-01', '2025-07-15')).toBe('2026-07-15');
    expect(readjustmentDateIn(2025, '2025-03-01', '2025-07-15')).toBe('2025-07-15');
  });

  it('a ocorrência nova não repete o " · n/N" das parcelas antigas', () => {
    expect(stripInstallmentSuffix('Suporte ACME · 3/12')).toBe('Suporte ACME');
    expect(stripInstallmentSuffix('Aluguel · Centro')).toBe('Aluguel · Centro');
    expect(stripInstallmentSuffix('Aluguel')).toBe('Aluguel');
  });

  it('o cadastro: vigência coerente, obrigação com conta ou cartão, rascunho sem obrigações', () => {
    const base = {
      caixaId: '00000000-0000-4000-8000-000000000001',
      entityId: '00000000-0000-4000-8000-000000000002',
      categoryId: '00000000-0000-4000-8000-000000000003',
      direction: 'receivable',
      name: 'Suporte',
      startsOn: '2025-03-01',
    };
    const obligation = { description: 'Mensalidade', amountCents: 100, firstDueDate: '2025-04-10', accountId: base.caixaId };
    const ok = contractCreateInput.parse({ ...base, endsOn: '2026-02-28', obligations: [obligation] });
    expect(ok.autoRenew).toBe(false);
    expect(ok.obligations[0]).toMatchObject({
      kind: 'account',
      frequency: 'monthly',
      intervalCount: 1,
      matchWindowDays: 15,
      autoSettle: false,
    });
    expect(contractCreateInput.parse(base).endsOn).toBeNull();
    expect(contractCreateInput.safeParse({ ...base, endsOn: '2025-02-01' }).success).toBe(false);
    expect(contractCreateInput.safeParse({ ...base, obligations: [{ ...obligation, accountId: null }] }).success).toBe(false);
    expect(
      contractCreateInput.safeParse({ ...base, obligations: [{ ...obligation, kind: 'card', accountId: null, cardCaixaId: base.caixaId }] })
        .success,
    ).toBe(true);
    expect(contractCreateInput.safeParse({ ...base, activate: false, obligations: [obligation] }).success).toBe(false);
  });

  it('o aditivo: valor ou reajuste, e alguma mudança', () => {
    const ruleIds = ['00000000-0000-4000-8000-000000000009'];
    expect(contractAmendmentInput.safeParse({ effectiveOn: '2025-08-01', ruleIds, amountCents: 1, readjustmentPercent: 3 }).success).toBe(
      false,
    );
    expect(contractAmendmentInput.safeParse({ effectiveOn: '2025-08-01', ruleIds }).success).toBe(false);
    expect(contractAmendmentInput.parse({ effectiveOn: '2025-08-01', ruleIds, anchorDay: 5 }).anchorDay).toBe(5);
  });
});

describe('diff de versões do markdown', () => {
  it('marca linhas iguais, incluídas e removidas', () => {
    const lines = diffLines('a\nb\nc\nd', 'a\nc\nd\ne');
    expect(lines.map((l) => `${l.kind}:${l.text}`)).toEqual(['same:a', 'del:b', 'same:c', 'same:d', 'add:e']);
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1 });
  });

  it('textos vazios e iguais', () => {
    expect(diffLines('', 'x').map((l) => l.kind)).toEqual(['add']);
    expect(diffLines('x', '').map((l) => l.kind)).toEqual(['del']);
    expect(diffLines('x\ny', 'x\ny').every((l) => l.kind === 'same')).toBe(true);
  });

  it('troca de linha vira remoção + inclusão, com os números de linha', () => {
    const lines = diffLines('# Título\nCláusula 1: R$ 100\nFim', '# Título\nCláusula 1: R$ 150\nFim');
    expect(lines.filter((l) => l.kind !== 'same')).toEqual([
      { kind: 'del', text: 'Cláusula 1: R$ 100', oldLine: 2, newLine: null },
      { kind: 'add', text: 'Cláusula 1: R$ 150', oldLine: null, newLine: 2 },
    ]);
  });
});
