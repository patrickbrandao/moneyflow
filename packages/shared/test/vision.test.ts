import { describe, expect, it } from 'vitest';
import {
  buildCategoryTree,
  buildEntityRows,
  type CategoryTotalLine,
  CSV_BOM,
  centsToCsv,
  clampLines,
  dedupKeys,
  dueReminderMessage,
  type EntityTotalLine,
  escapeHtml,
  exportFileName,
  formatCell,
  invoiceClosedMessage,
  isTimeReached,
  limitPercent,
  monthsBetween,
  overdueSchedule,
  rankCategories,
  reminderDueDates,
  spClock,
  summaryMessage,
  TELEGRAM_TEXT_LIMIT,
  toCsv,
  variation,
  weekStart,
} from '../src';

describe('mensagens: escape HTML do Telegram', () => {
  it('escapa &, <, > e aspas', () => {
    expect(escapeHtml('a < b && c > "d"')).toBe('a &lt; b &amp;&amp; c &gt; &quot;d&quot;');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });

  it('lembrete com linha digitável e PIX em <code>, texto do usuário escapado', () => {
    const msg = dueReminderMessage(
      {
        description: 'Luz <b>falsa</b>',
        direction: 'payable',
        dueDate: '2026-10-12',
        openCents: 123_456,
        caixaName: 'Casa & Cia',
        entityName: 'Enel',
        boletoBarcode: '23793381286000000000300000000400100000012345',
        pixPayload: '00020126<x>',
      },
      0,
      'https://mf.exemplo/caixas/1/payables?title=2&x=1',
    );
    expect(msg.parse_mode).toBe('HTML');
    expect(msg.text).toContain('<b>Vence hoje</b>');
    expect(msg.text).toContain('<b>Luz &lt;b&gt;falsa&lt;/b&gt;</b>');
    expect(msg.text).toContain('Casa &amp; Cia');
    expect(msg.text).toContain('R$');
    expect(msg.text).toContain('12/10/2026');
    expect(msg.text).toMatch(/<code>[0-9. ]+<\/code>/);
    expect(msg.text).toContain('<code>00020126&lt;x&gt;</code>');
    expect(msg.text).toContain('<a href="https://mf.exemplo/caixas/1/payables?title=2&amp;x=1">');
    // Sem tags soltas: tudo o que abre fecha.
    for (const tag of ['b', 'code', 'a']) {
      expect((msg.text.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length).toBe(
        (msg.text.match(new RegExp(`</${tag}>`, 'g')) ?? []).length,
      );
    }
  });

  it('resumo e fatura fechada', () => {
    const summary = summaryMessage({
      heading: 'Resumo do dia 11/10/2026',
      dueLabel: 'Vencem hoje',
      due: [{ description: 'Internet', direction: 'payable', dueDate: '2026-10-11', openCents: 9_990, caixaName: 'Casa' }],
      overdue: { count: 2, cents: 5_000 },
      balances: [{ caixaName: 'Casa', cents: 150_000 }],
      flowLabel: 'Entradas e saídas de ontem',
      flow: [{ caixaName: 'Casa', inflowCents: 10_000, outflowCents: 2_500 }],
      showDueDate: false,
    });
    expect(summary.text).toContain('<b>Resumo do dia 11/10/2026</b>');
    expect(summary.text).toContain('Internet');
    expect(summary.text).toContain('Atrasados: 2 títulos');
    const invoice = invoiceClosedMessage({
      cardName: 'Nubank',
      referenceMonth: '2026-10-01',
      dueDate: '2026-10-10',
      totalCents: 30_000,
      payers: [
        { caixaName: 'Casa', cents: 20_000 },
        { caixaName: 'Empresa', cents: 10_000 },
      ],
    });
    expect(invoice.text).toContain('Fatura fechada: Nubank 10/2026');
    expect(invoice.text).toContain('Empresa');
    expect(invoice.text).not.toContain('<a ');
  });

  it('corta no limite do Telegram sem quebrar linhas', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `<b>linha ${i}</b> ${'x'.repeat(20)}`);
    const text = clampLines(lines);
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(text).toMatch(/… e mais \d+$/);
    expect(
      text
        .split('\n')
        .slice(0, -1)
        .every((line) => line.endsWith('x')),
    ).toBe(true);
  });

  it('percentual do limite', () => {
    expect(limitPercent(80_000, 100_000)).toBe(80);
    expect(limitPercent(79_999, 100_000)).toBe(79);
    expect(limitPercent(1, 0)).toBe(999);
    expect(limitPercent(0, 0)).toBe(0);
  });
});

describe('mensagens: agendamento no fuso de São Paulo', () => {
  it('relógio de SP a partir de um instante UTC', () => {
    // 02:30 UTC de 12/10 = 23:30 de 11/10 em São Paulo (UTC−3).
    expect(spClock(new Date('2026-10-12T02:30:00Z'))).toEqual({ date: '2026-10-11', time: '23:30', weekday: 7 });
    expect(spClock(new Date('2026-10-12T11:05:00Z'))).toEqual({ date: '2026-10-12', time: '08:05', weekday: 1 });
  });

  it('horário de envio atingido (quem perdeu o horário envia ao voltar no mesmo dia)', () => {
    const clock = { date: '2026-10-12', time: '08:00', weekday: 1 };
    expect(isTimeReached('08:00', clock)).toBe(true);
    expect(isTimeReached('08:01', clock)).toBe(false);
    expect(isTimeReached('07:59', { ...clock, time: '15:00' })).toBe(true);
  });

  it('datas de vencimento dos lembretes D-N', () => {
    expect(reminderDueDates('2026-10-30', [3, 1, 0])).toEqual([
      { daysBefore: 3, dueDate: '2026-11-02' },
      { daysBefore: 1, dueDate: '2026-10-31' },
      { daysBefore: 0, dueDate: '2026-10-30' },
    ]);
  });

  it('atrasados: uma vez sem repetição; a cada N dias com repetição', () => {
    expect(overdueSchedule('2026-10-12', '2026-10-12')).toBeNull();
    expect(overdueSchedule('2026-10-10', '2026-10-12')).toEqual({ send: true, dedupKey: '', daysLate: 2 });
    expect(overdueSchedule('2026-10-10', '2026-10-11', 3)).toEqual({ send: true, dedupKey: '2026-10-11', daysLate: 1 });
    expect(overdueSchedule('2026-10-10', '2026-10-12', 3)?.send).toBe(false);
    expect(overdueSchedule('2026-10-10', '2026-10-14', 3)?.send).toBe(true);
    expect(dedupKeys.overdue('t1', '')).toBe('overdue:t1');
    expect(dedupKeys.overdue('t1', '2026-10-14')).toBe('overdue:t1:2026-10-14');
  });

  it('semana começa na segunda', () => {
    expect(weekStart('2026-10-11')).toBe('2026-10-05');
    expect(weekStart('2026-10-12')).toBe('2026-10-12');
  });
});

describe('exportação CSV', () => {
  it('dinheiro, datas, aspas, separador e proteção contra fórmula', () => {
    const csv = toCsv({
      columns: [
        { key: 'name', label: 'Nome' },
        { key: 'date', label: 'Data', type: 'date' },
        { key: 'value', label: 'Valor', type: 'money' },
        { key: 'n', label: 'Qtd', type: 'int' },
      ],
      rows: [
        { name: 'Padaria; "Pão"', date: '2026-10-05', value: 123_456, n: 3 },
        { name: '=SOMA(A1)', date: null, value: -5, n: 0 },
        { name: 'Linha\nquebrada', date: '2026-01-31', value: 0, n: 1 },
      ],
    });
    expect(csv.split('\r\n')).toEqual([
      'Nome;Data;Valor;Qtd',
      '"Padaria; ""Pão""";05/10/2026;1234,56;3',
      "'=SOMA(A1);;-0,05;0",
      '"Linha\nquebrada";31/01/2026;0,00;1',
      '',
    ]);
    expect(CSV_BOM).toBe('\uFEFF');
  });

  it('formatos de célula e nome de arquivo', () => {
    expect(centsToCsv(-123_456)).toBe('-1234,56');
    expect(formatCell(123_456_789, 'money', 'display')).toBe('R$ 1.234.567,89');
    expect(formatCell(-1_000, 'money', 'display')).toBe('−R$ 10,00');
    expect(formatCell(12.345, 'percent')).toBe('12,3%');
    expect(exportFileName('Relatório', 'Despesas por categoria', '2026')).toBe('relatorio-despesas-por-categoria-2026');
  });
});

describe('relatórios: árvore por categoria e entidades', () => {
  const line = (over: Partial<CategoryTotalLine>): CategoryTotalLine => ({
    month: '2026-01-01',
    caixaId: 'A',
    cardCaixaId: null,
    kind: 'expense',
    groupCategoryId: 'g1',
    groupName: 'Casa',
    groupColorSlot: 3,
    categoryId: 'c1',
    categoryName: 'Luz',
    colorSlot: null,
    source: 'title',
    isInternal: false,
    amountCents: 100,
    entries: 1,
    ...over,
  });
  const lines = [
    line({}),
    line({ month: '2026-02-01', amountCents: 150 }),
    line({ categoryId: 'c2', categoryName: 'Água', amountCents: 50 }),
    line({ groupCategoryId: 'g2', groupName: 'Família', categoryId: 'c3', categoryName: 'Mesada', amountCents: 1_000, isInternal: true }),
    line({ caixaId: 'B', amountCents: 7 }),
    line({ kind: 'income', amountCents: 9_999 }),
  ];
  const months = monthsBetween('2026-01-15', '2026-02-10');

  it('consolidado descarta o interno; por caixa mantém', () => {
    expect(months).toEqual(['2026-01-01', '2026-02-01']);
    const all = buildCategoryTree(lines, months, 'expense', { caixaId: null });
    expect(all.rows.map((r) => r.name)).toEqual(['Casa']);
    expect(all.rows[0]!.byMonth).toEqual([157, 150]);
    expect(all.total).toBe(307);
    expect(all.rows[0]!.children.map((c) => [c.name, c.total])).toEqual([
      ['Luz', 257],
      ['Água', 50],
    ]);
    expect(all.rows[0]!.children[0]!.colorSlot).toBe(3); // herda a cor do grupo
    const onlyA = buildCategoryTree(lines, months, 'expense', { caixaId: 'A' });
    expect(onlyA.rows.map((r) => r.name)).toEqual(['Família', 'Casa']);
    expect(onlyA.total).toBe(1_300);
    expect(rankCategories(onlyA, 2).map((r) => r.name)).toEqual(['Mesada', 'Luz']);
  });

  it('variação do último mês contra o anterior', () => {
    expect(variation(100, 150)).toBe(0.5);
    expect(variation(0, 10)).toBeNull();
    const tree = buildCategoryTree(lines, months, 'expense', { caixaId: 'A' });
    const luz = tree.rows.find((r) => r.name === 'Casa')!.children.find((c) => c.name === 'Luz')!;
    expect(luz.variation).toBe(0.5);
  });

  it('entidades com o rastreio pagadora → cartão', () => {
    const e = (over: Partial<EntityTotalLine>): EntityTotalLine => ({
      entityId: 'loja',
      entityName: 'Loja',
      caixaId: 'A',
      caixaName: 'Casa',
      cardCaixaId: 'K',
      cardName: 'Cartão',
      source: 'card_purchase',
      isInternal: false,
      outflowCents: 500,
      inflowCents: 0,
      entries: 2,
      ...over,
    });
    const rows = buildEntityRows(
      [e({}), e({ caixaId: 'B', caixaName: 'Empresa', outflowCents: 300 }), e({ entityId: 'x', entityName: 'X', isInternal: true })],
      { caixaId: null },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityName: 'Loja', outflowCents: 800, netCents: -800, entries: 4 });
    expect(rows[0]!.trail.map((t) => [t.caixaName, t.cardName])).toEqual([
      ['Casa', 'Cartão'],
      ['Empresa', 'Cartão'],
    ]);
  });
});
