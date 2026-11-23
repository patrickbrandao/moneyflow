import { describe, expect, it } from 'vitest';
import { addMonths, diffDays, formatDate, isIsoDate, isoWeekday, parseDateBR, todayIso } from '../src/dates';
import { formatAccounting, formatBRL, formatCents, formatSignedBRL, parseBRL } from '../src/money';
import { occurrenceCompetenceDate, occurrenceDueDate, pendingOccurrences, type RecurrenceRule } from '../src/recurrence';

const nbsp = (s: string) => s.replace(/ /g, ' ');

describe('dinheiro', () => {
  it('formata BRL a partir de centavos', () => {
    expect(nbsp(formatBRL(123456))).toBe('R$ 1.234,56');
    expect(nbsp(formatBRL(5))).toBe('R$ 0,05');
    expect(nbsp(formatSignedBRL(-1000))).toBe('−R$ 10,00');
  });
  it('formato contábil: negativo entre parênteses, sem sinal', () => {
    expect(nbsp(formatAccounting(-123456))).toBe('(R$ 1.234,56)');
    expect(nbsp(formatAccounting(0))).toBe('R$ 0,00');
    expect(nbsp(formatAccounting(500))).toBe('R$ 5,00');
  });
  it('o zero negativo sai sem sinal (tarefa 174)', () => {
    expect(nbsp(formatAccounting(-0))).toBe('R$ 0,00');
    expect(nbsp(formatBRL(-0))).toBe('R$ 0,00');
    expect(formatCents(-0)).toBe('0,00');
    expect(nbsp(formatSignedBRL(-0))).toBe('R$ 0,00');
    expect(Object.is(parseBRL('-0'), 0)).toBe(true);
    expect(Object.is(parseBRL('-0,00'), 0)).toBe(true);
  });
  it('lê valores digitados', () => {
    expect(parseBRL('1.234,56')).toBe(123456);
    expect(parseBRL('R$ 10')).toBe(1000);
    expect(parseBRL('10,5')).toBe(1050);
    expect(parseBRL('10.50')).toBe(1050);
    expect(parseBRL('1.234')).toBe(123400);
    expect(parseBRL('-3,00')).toBe(-300);
    expect(parseBRL('abc')).toBeNull();
    expect(parseBRL('1,234')).toBeNull();
  });
});

describe('datas', () => {
  it('formata e lê dd/mm/aaaa', () => {
    expect(formatDate('2026-10-09')).toBe('09/10/2026');
    expect(parseDateBR('9/10/2026')).toBe('2026-10-09');
    expect(parseDateBR('31/02/2026')).toBeNull();
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2028-02-29')).toBe(true);
  });
  it('soma meses usando o último dia em meses curtos', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-02-28', 1, 31)).toBe('2026-03-31');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
  });
  it('hoje é no fuso de São Paulo', () => {
    // 02:00 UTC de 11/10 ainda é 10/10 em São Paulo (UTC−3)
    expect(todayIso(new Date('2026-10-11T02:00:00Z'))).toBe('2026-10-10');
  });
  it('dia da semana ISO e diferença', () => {
    expect(isoWeekday('2026-10-12')).toBe(1);
    expect(isoWeekday('2026-10-11')).toBe(7);
    expect(diffDays('2026-10-01', '2026-10-31')).toBe(30);
  });
});

describe('recorrência', () => {
  const monthly: RecurrenceRule = { frequency: 'monthly', intervalCount: 1, anchorDay: 31, startsOn: '2026-01-31' };
  it('mensal no dia âncora com meses curtos', () => {
    expect(occurrenceDueDate(monthly, 1)).toBe('2026-01-31');
    expect(occurrenceDueDate(monthly, 2)).toBe('2026-02-28');
    expect(occurrenceDueDate(monthly, 3)).toBe('2026-03-31');
  });
  it('semanal no dia da semana âncora', () => {
    const weekly: RecurrenceRule = { frequency: 'weekly', intervalCount: 2, anchorDay: 5, startsOn: '2026-10-10' };
    expect(occurrenceDueDate(weekly, 1)).toBe('2026-10-16');
    expect(occurrenceDueDate(weekly, 2)).toBe('2026-10-30');
  });
  it('anual', () => {
    const yearly: RecurrenceRule = { frequency: 'yearly', intervalCount: 1, anchorDay: 29, startsOn: '2028-02-29' };
    expect(occurrenceDueDate(yearly, 2)).toBe('2029-02-28');
  });
  it('competência acompanha o calendário a partir do modelo', () => {
    expect(occurrenceCompetenceDate(monthly, { occurrence: 2, competenceDate: '2026-02-01' }, 5)).toBe('2026-05-01');
  });
  it('competência no dia 31 não fica presa no 28 depois de fevereiro (tarefa 170)', () => {
    const m31: RecurrenceRule = { frequency: 'monthly', intervalCount: 1, anchorDay: 31, startsOn: '2026-01-31' };
    // Sem a âncora, o modelo de fevereiro prende o dia 28.
    expect(occurrenceCompetenceDate(m31, { occurrence: 2, competenceDate: '2026-02-28' }, 3)).toBe('2026-03-28');
    expect(occurrenceCompetenceDate(m31, { occurrence: 2, competenceDate: '2026-02-28' }, 3, 31)).toBe('2026-03-31');
    expect(occurrenceCompetenceDate(m31, { occurrence: 2, competenceDate: '2026-02-28' }, 4, 31)).toBe('2026-04-30');
    expect(occurrenceCompetenceDate(m31, { occurrence: 1, competenceDate: '2026-01-31' }, 2, 31)).toBe('2026-02-28');
    // Dia 1 e 15 não mudam.
    expect(occurrenceCompetenceDate(monthly, { occurrence: 2, competenceDate: '2026-02-01' }, 5, 1)).toBe('2026-05-01');
    expect(occurrenceCompetenceDate(monthly, { occurrence: 2, competenceDate: '2026-02-15' }, 5, 15)).toBe('2026-05-15');
    const yearly: RecurrenceRule = { frequency: 'yearly', intervalCount: 1, anchorDay: 29, startsOn: '2028-02-29' };
    expect(occurrenceCompetenceDate(yearly, { occurrence: 2, competenceDate: '2029-02-28' }, 5, 29)).toBe('2032-02-29');
  });
  it('pendências respeitam parcelas, fim e horizonte', () => {
    expect(pendingOccurrences({ ...monthly, installmentsTotal: 3 }, 1, '2030-01-01')).toEqual([2, 3]);
    expect(pendingOccurrences({ ...monthly, endsOn: '2026-04-15' }, 1, '2030-01-01')).toEqual([2, 3]);
    expect(pendingOccurrences(monthly, 0, '2026-03-30')).toEqual([1, 2]);
  });
});
