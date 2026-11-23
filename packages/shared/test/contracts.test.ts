import { describe, expect, it } from 'vitest';
import {
  contractAmendmentInput,
  contractCreateInput,
  cycleEnd,
  DIFF_MAX_EDITS,
  type DiffLine,
  diffLines,
  diffStats,
  diffText,
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

  // Os dois lados saem do diff, com os números de linha em sequência.
  const rebuild = (lines: DiffLine[]) => {
    const before = lines.filter((l) => l.kind !== 'add');
    const after = lines.filter((l) => l.kind !== 'del');
    expect(before.map((l) => l.oldLine)).toEqual(before.map((_, i) => i + 1));
    expect(after.map((l) => l.newLine)).toEqual(after.map((_, i) => i + 1));
    return { before: before.map((l) => l.text), after: after.map((l) => l.text) };
  };
  const lcs = (a: string[], b: string[]) => {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i += 1) {
      let diag = 0;
      for (let j = 1; j <= b.length; j += 1) {
        const up = row[j]!;
        row[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(row[j]!, row[j - 1]!);
        diag = up;
      }
    }
    return row[b.length]!;
  };

  it('textos aleatórios: o diff reconstrói os dois lados e é o menor (tarefa 112)', () => {
    let seed = 112;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let round = 0; round < 500; round += 1) {
      const a = Array.from({ length: rand(12) }, () => 'abcd'[rand(4)]!);
      const b = Array.from({ length: rand(12) }, () => 'abcd'[rand(4)]!);
      const lines = diffLines(a.join('\n'), b.join('\n'));
      const sides = rebuild(lines);
      expect(sides.before).toEqual(a);
      expect(sides.after).toEqual(b);
      const { added, removed } = diffStats(lines);
      expect(added + removed).toBe(a.length + b.length - 2 * lcs(a, b));
    }
  });

  it('documento grande com uma linha trocada no meio dá 1 inclusão e 1 remoção', () => {
    const before = Array.from({ length: 10_000 }, (_, i) => `linha ${i}`);
    const after = [...before];
    after[5_000] = 'linha trocada';
    const result = diffText(before.join('\n'), after.join('\n'));
    expect(result.truncated).toBe(false);
    expect(diffStats(result.lines)).toEqual({ added: 1, removed: 1 });
    expect(result.lines.filter((l) => l.kind !== 'same')).toEqual([
      { kind: 'del', text: 'linha 5000', oldLine: 5001, newLine: null },
      { kind: 'add', text: 'linha trocada', oldLine: null, newLine: 5001 },
    ]);
  });

  it('8.000 × 8.000 linhas diferentes: o miolo sai resumido, rápido e válido', () => {
    const before = Array.from({ length: 8_000 }, (_, i) => `linha antiga ${i}`).join('\n');
    const after = Array.from({ length: 8_000 }, (_, i) => `linha nova ${i}`).join('\n');
    const started = performance.now();
    const result = diffText(before, after);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result.truncated).toBe(true);
    expect(diffStats(result.lines)).toEqual({ added: 8_000, removed: 8_000 });
    const sides = rebuild(result.lines);
    expect(sides.before.join('\n')).toBe(before);
    expect(sides.after.join('\n')).toBe(after);
    // Prefixo e sufixo comuns continuam iguais em volta do miolo resumido.
    const wrapped = diffText(`topo\n${before}\nfim`, `topo\n${after}\nfim`);
    expect(wrapped.truncated).toBe(true);
    expect(wrapped.lines[0]).toEqual({ kind: 'same', text: 'topo', oldLine: 1, newLine: 1 });
    expect(wrapped.lines.at(-1)).toEqual({ kind: 'same', text: 'fim', oldLine: 8_002, newLine: 8_002 });
  });

  it('até o teto de linhas diferentes, o diff é exato', () => {
    const half = DIFF_MAX_EDITS / 2;
    const before = Array.from({ length: half }, (_, i) => `antiga ${i}`).join('\n');
    const after = Array.from({ length: half }, (_, i) => `nova ${i}`).join('\n');
    const exact = diffText(before, after);
    expect(exact.truncated).toBe(false);
    expect(diffStats(exact.lines)).toEqual({ added: half, removed: half });
    expect(diffText(`${before}\nx`, after).truncated).toBe(true);
  });

  it('troca de linha vira remoção + inclusão, com os números de linha', () => {
    const lines = diffLines('# Título\nCláusula 1: R$ 100\nFim', '# Título\nCláusula 1: R$ 150\nFim');
    expect(lines.filter((l) => l.kind !== 'same')).toEqual([
      { kind: 'del', text: 'Cláusula 1: R$ 100', oldLine: 2, newLine: null },
      { kind: 'add', text: 'Cláusula 1: R$ 150', oldLine: null, newLine: 2 },
    ]);
  });
});
