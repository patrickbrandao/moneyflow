import { describe, expect, it } from 'vitest';
import { PROJECTION_METRICS, projectionExport, projectionValue } from '../src/reports';
import type { ProjectionLine } from '../src/types';

/* Fluxo projetado exportado com os sinais da tela (tarefa 179, spec 014). */

const line: ProjectionLine = {
  caixaId: 'c1',
  caixaName: 'Casa',
  financialAccountId: null,
  accountName: null,
  horizonDays: 30,
  until: '2026-12-21',
  balanceTodayCents: 100_000,
  scheduledMovementsCents: -5_000,
  receivableCents: 30_000,
  // A API devolve as saídas positivas. Os vencidos são a parte vencida do a receber e do a pagar.
  payableCents: 40_000,
  overdueReceivableCents: 2_000,
  overduePayableCents: 3_000,
  // projected_cents = saldo + lançados + a receber − a pagar (0018_reports.sql).
  projectedCents: 100_000 - 5_000 + 30_000 - 40_000,
};

describe('fluxo projetado', () => {
  it('a pagar e vencidos a pagar saem negativos, como na tela', () => {
    const table = projectionExport({ today: '2026-11-21', horizons: [30], lines: [line], entityFilter: null }, ['Consolidado']);
    const row = table.rows[0]!;
    expect(row.payableCents).toBe(-40_000);
    expect(row.overduePayableCents).toBe(-3_000);
    expect(row.receivableCents).toBe(30_000);
    expect(row.scheduledMovementsCents).toBe(-5_000);
    // Na planilha, saldo + agendado + a receber + a pagar dá o projetado.
    const parts = ['balanceTodayCents', 'scheduledMovementsCents', 'receivableCents', 'payableCents'];
    expect(parts.reduce((sum, key) => sum + Number(row[key]), 0)).toBe(row.projectedCents);
    // A linha da caixa é a de destaque; as colunas de valor são dinheiro.
    expect(table.boldRows).toEqual([0]);
    expect(table.columns.filter((c) => c.type === 'money').map((c) => c.key)).toEqual(PROJECTION_METRICS.map((m) => m.key));
  });

  it('o valor da tela vira o sinal só das saídas', () => {
    const payable = PROJECTION_METRICS.find((m) => m.key === 'payableCents')!;
    const projected = PROJECTION_METRICS.find((m) => m.key === 'projectedCents')!;
    expect(projectionValue(line, payable)).toBe(-40_000);
    expect(projectionValue(line, projected)).toBe(line.projectedCents);
    expect(Object.is(projectionValue(undefined, payable), 0)).toBe(true);
  });
});
