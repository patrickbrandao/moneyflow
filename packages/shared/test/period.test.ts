import { describe, expect, it } from 'vitest';
import { activePeriodShortcut, applyPeriodShortcut, defaultPeriod, monthPeriod, periodMonth } from '../src/period';

const today = '2026-10-20';

describe('período dos filtros de data', () => {
  it('padrão: últimos 60 dias e próximos 30', () => {
    expect(defaultPeriod(today)).toEqual({ from: '2026-08-21', to: '2026-11-19' });
  });

  it('mês atual, hoje e o mês inteiro', () => {
    expect(applyPeriodShortcut('thisMonth', defaultPeriod(today), today)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(applyPeriodShortcut('today', defaultPeriod(today), today)).toEqual({ from: today, to: today });
    expect(monthPeriod('2028-02-15')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(periodMonth({ from: '2026-10-01', to: '2026-10-30' })).toBeNull();
  });

  it('mês anterior e próximo andam a partir do mês mostrado', () => {
    const prev = applyPeriodShortcut('prevMonth', defaultPeriod(today), today);
    expect(prev).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(applyPeriodShortcut('prevMonth', prev, today)).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(applyPeriodShortcut('nextMonth', { from: '2026-12-01', to: '2026-12-31' }, today)).toEqual({
      from: '2027-01-01',
      to: '2027-01-31',
    });
    // fora de um mês inteiro, parte do mês atual
    expect(applyPeriodShortcut('nextMonth', { from: '', to: '' }, today)).toEqual({ from: '2026-11-01', to: '2026-11-30' });
  });

  it('reconhece o atalho ativo', () => {
    expect(activePeriodShortcut(defaultPeriod(today), today)).toBe('default');
    expect(activePeriodShortcut({ from: '2026-09-01', to: '2026-09-30' }, today)).toBe('prevMonth');
    expect(activePeriodShortcut({ from: '2026-11-01', to: '2026-11-30' }, today)).toBe('nextMonth');
    expect(activePeriodShortcut({ from: '2026-10-01', to: '2026-10-31' }, today)).toBe('thisMonth');
    expect(activePeriodShortcut({ from: today, to: today }, today)).toBe('today');
    expect(activePeriodShortcut({ from: '2026-05-01', to: '2026-05-31' }, today)).toBeNull();
  });
});
