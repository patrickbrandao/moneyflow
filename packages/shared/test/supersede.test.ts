import { describe, expect, it } from 'vitest';
import { pairSupersedeLines, periodsOverlap, type SupersedeLine } from '../src/supersede';

const line = (id: string, postedOn: string, amountCents: number, description = 'PIX'): SupersedeLine => ({
  id,
  postedOn,
  amountCents,
  description,
});

describe('pairSupersedeLines (spec 031)', () => {
  it('casa data e valor exatos com correspondência única, mesmo com descrição diferente', () => {
    const pairs = pairSupersedeLines(
      [line('p1', '2026-10-03', -5000, 'PIX ENVIADO FULANO'), line('p2', '2026-10-04', 12000)],
      [line('c1', '2026-10-03', -5000, 'PIX TRANSF FULANO 03/10'), line('c2', '2026-10-04', 12000), line('c3', '2026-10-05', 100)],
    );
    expect(Object.fromEntries(pairs)).toEqual({ p1: 'c1', p2: 'c2' });
  });

  it('não casa data deslocada nem valor diferente', () => {
    const pairs = pairSupersedeLines(
      [line('p1', '2026-10-03', -5000), line('p2', '2026-10-04', -100)],
      [line('c1', '2026-10-05', -5000), line('c2', '2026-10-04', -101)],
    );
    expect(pairs.size).toBe(0);
  });

  it('desempata repetições do mesmo dia e valor pela descrição normalizada idêntica', () => {
    const pairs = pairSupersedeLines(
      [line('p1', '2026-10-03', -990, 'Tarifa  pacote'), line('p2', '2026-10-03', -990, 'IOF')],
      [line('c1', '2026-10-03', -990, 'IOF'), line('c2', '2026-10-03', -990, 'TARIFA PACOTE')],
    );
    expect(Object.fromEntries(pairs)).toEqual({ p1: 'c2', p2: 'c1' });
  });

  it('deixa sem par as repetições sem desempate', () => {
    const pairs = pairSupersedeLines(
      [line('p1', '2026-10-03', -990, 'IOF'), line('p2', '2026-10-03', -990, 'IOF')],
      [line('c1', '2026-10-03', -990, 'IOF'), line('c2', '2026-10-03', -990, 'IOF')],
    );
    expect(pairs.size).toBe(0);
  });

  it('periodsOverlap inclui as pontas', () => {
    expect(
      periodsOverlap({ periodStart: '2026-10-01', periodEnd: '2026-10-15' }, { periodStart: '2026-10-15', periodEnd: '2026-10-31' }),
    ).toBe(true);
    expect(
      periodsOverlap({ periodStart: '2026-09-01', periodEnd: '2026-09-30' }, { periodStart: '2026-10-01', periodEnd: '2026-10-31' }),
    ).toBe(false);
  });
});
