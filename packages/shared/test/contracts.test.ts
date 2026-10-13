import { describe, expect, it } from 'vitest';
import {
  amendInstallments,
  contractCreateInput,
  cycleEnd,
  cycleSchedule,
  diffLines,
  diffStats,
  dueDateFor,
  installmentsCount,
  proratedAmount,
  readjustedTotal,
  readjustmentDateIn,
  renewalReminderDue,
  splitTotal,
} from '../src';

describe('contratos: ciclo e parcelas (spec 020)', () => {
  it('fim do ciclo é o dia anterior ao mesmo dia, duração meses depois', () => {
    expect(cycleEnd('2025-03-01', 12)).toBe('2026-02-28');
    expect(cycleEnd('2024-03-01', 12)).toBe('2025-02-28');
    expect(cycleEnd('2025-01-15', 1)).toBe('2025-02-14');
    expect(cycleEnd('2025-01-31', 1)).toBe('2025-02-28');
    expect(cycleEnd('2025-03-31', 1)).toBe('2025-04-30');
    expect(cycleEnd('2025-01-30', 1)).toBe('2025-02-28');
    expect(cycleEnd('2024-01-29', 1)).toBe('2024-02-28');
  });

  it('número de parcelas pela periodicidade', () => {
    expect(installmentsCount(12, 'monthly')).toBe(12);
    expect(installmentsCount(12, 'quarterly')).toBe(4);
    expect(installmentsCount(12, 'semiannual')).toBe(2);
    expect(installmentsCount(24, 'annual')).toBe(2);
    expect(installmentsCount(7, 'single')).toBe(1);
    expect(installmentsCount(10, 'quarterly')).toBeNull();
    expect(installmentsCount(0, 'monthly')).toBeNull();
    expect(installmentsCount(121, 'monthly')).toBeNull();
  });

  it('divide em parcelas iguais com o resto na primeira', () => {
    expect(splitTotal(6_000_001, 12)).toEqual([500_001, ...Array(11).fill(500_000)]);
    expect(splitTotal(100, 3)).toEqual([34, 33, 33]);
    expect(splitTotal(100, 1)).toEqual([100]);
  });

  it('vencimento por dia fixo + deslocamento, último dia em mês curto', () => {
    expect(dueDateFor('2025-03-01', 10, 1)).toBe('2025-04-10');
    expect(dueDateFor('2025-03-15', 31, 0)).toBe('2025-03-31');
    expect(dueDateFor('2025-01-01', 31, 1)).toBe('2025-02-28');
    expect(dueDateFor('2025-11-01', 5, 3)).toBe('2026-02-05');
  });

  it('o exemplo da spec: 12 meses de mar/2025 a fev/2026, vence dia 10 do mês seguinte', () => {
    const rows = cycleSchedule({
      startsOn: '2025-03-01',
      durationMonths: 12,
      periodicity: 'monthly',
      totalCents: 6_000_001,
      dueDay: 10,
      dueMonthOffset: 1,
    });
    expect(rows).toHaveLength(12);
    expect(rows[0]).toEqual({
      installment: 1,
      competenceDate: '2025-03-01',
      periodEnd: '2025-03-31',
      dueDate: '2025-04-10',
      amountCents: 500_001,
    });
    expect(rows[11]).toMatchObject({ installment: 12, competenceDate: '2026-02-01', periodEnd: '2026-02-28', dueDate: '2026-03-10' });
    expect(rows.reduce((acc, r) => acc + r.amountCents, 0)).toBe(6_000_001);
  });

  it('trimestral começando no dia 15 cobre períodos de 3 meses', () => {
    const rows = cycleSchedule({
      startsOn: '2025-01-15',
      durationMonths: 12,
      periodicity: 'quarterly',
      totalCents: 120_000,
      dueDay: 5,
      dueMonthOffset: 0,
    });
    expect(rows.map((r) => [r.competenceDate, r.periodEnd, r.dueDate])).toEqual([
      ['2025-01-15', '2025-04-14', '2025-01-05'],
      ['2025-04-15', '2025-07-14', '2025-04-05'],
      ['2025-07-15', '2025-10-14', '2025-07-05'],
      ['2025-10-15', '2026-01-14', '2025-10-05'],
    ]);
  });

  it('parcela única cobre o ciclo inteiro', () => {
    const rows = cycleSchedule({
      startsOn: '2025-03-01',
      durationMonths: 6,
      periodicity: 'single',
      totalCents: 9_000,
      dueDay: 1,
      dueMonthOffset: 0,
    });
    expect(rows).toEqual([
      { installment: 1, competenceDate: '2025-03-01', periodEnd: '2025-08-31', dueDate: '2025-03-01', amountCents: 9_000 },
    ]);
  });

  it('proporcional da parcela na rescisão', () => {
    expect(proratedAmount(31_000, '2025-03-01', '2025-03-31', '2025-03-10')).toBe(10_000);
    expect(proratedAmount(31_000, '2025-03-01', '2025-03-31', '2025-03-31')).toBe(31_000);
    expect(proratedAmount(31_000, '2025-03-01', '2025-03-31', '2025-02-28')).toBe(0);
  });

  it('reajuste em % sobre o total', () => {
    expect(readjustedTotal(6_000_001, 4.5)).toBe(6_270_001);
  });

  it('aditivo: valor por parcela, total restante com o resto na primeira, e novo vencimento', () => {
    const affected = [
      { id: 'b', competenceDate: '2025-09-01', amountCents: 100, dueDate: '2025-10-10' },
      { id: 'a', competenceDate: '2025-08-01', amountCents: 100, dueDate: '2025-09-10' },
    ];
    expect(amendInstallments(affected, { installmentCents: 150 }, { dueDay: 10, dueMonthOffset: 1 })).toEqual([
      { id: 'a', amountCents: 150, dueDate: '2025-09-10' },
      { id: 'b', amountCents: 150, dueDate: '2025-10-10' },
    ]);
    expect(
      amendInstallments(affected, { remainingTotalCents: 301, dueDay: 5, dueMonthOffset: 0 }, { dueDay: 10, dueMonthOffset: 1 }),
    ).toEqual([
      { id: 'a', amountCents: 151, dueDate: '2025-08-05' },
      { id: 'b', amountCents: 150, dueDate: '2025-09-05' },
    ]);
  });

  it('data-base do reajuste: aniversário ou a informada, só depois do início', () => {
    expect(readjustmentDateIn(2025, '2025-03-01', null)).toBeNull();
    expect(readjustmentDateIn(2026, '2025-03-01', null)).toBe('2026-03-01');
    expect(readjustmentDateIn(2026, '2025-03-01', '2025-07-15')).toBe('2026-07-15');
    expect(readjustmentDateIn(2025, '2025-03-01', '2025-07-15')).toBe('2025-07-15');
  });

  it('lembrete da renovação pendente a cada N dias', () => {
    expect(renewalReminderDue('2026-01-01', '2026-01-01', 7)).toBe(true);
    expect(renewalReminderDue('2026-01-01', '2026-01-05', 7)).toBe(false);
    expect(renewalReminderDue('2026-01-01', '2026-01-08', 7)).toBe(true);
    expect(renewalReminderDue('2026-01-01', '2026-01-08', null)).toBe(true);
  });

  it('o cadastro recusa duração que não é múltipla do período', () => {
    const base = {
      caixaId: '00000000-0000-4000-8000-000000000001',
      entityId: '00000000-0000-4000-8000-000000000002',
      categoryId: '00000000-0000-4000-8000-000000000003',
      direction: 'receivable',
      name: 'Suporte',
      startsOn: '2025-03-01',
      totalCents: 100,
      dueDay: 10,
      dueMonthOffset: 0,
    };
    expect(contractCreateInput.safeParse({ ...base, durationMonths: 10, periodicity: 'quarterly' }).success).toBe(false);
    const ok = contractCreateInput.parse({ ...base, durationMonths: 12, periodicity: 'quarterly' });
    expect(ok.autoRenew).toBe(false);
    expect(ok.renewalLeadDays).toBe(60);
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
