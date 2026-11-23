// Testes de scripts/coverage-summary.mjs (tarefa 126): `pnpm test:scripts`.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { cell, coverageTable, readSummaries } from './coverage-summary.mjs';

const metric = (covered, total) => ({ total, covered, skipped: 0, pct: total ? (covered / total) * 100 : 100 });
const summary = { total: { lines: metric(7, 8), statements: metric(9, 12), functions: metric(1, 3), branches: metric(0, 0) } };

describe('coverage-summary', () => {
  it('formata a célula em pt-BR com os números e "—" quando não há o que medir', () => {
    assert.equal(cell(metric(7, 8)), '87,5% (7/8)');
    assert.equal(cell(metric(0, 0)), '—');
    assert.equal(cell(undefined), '—');
  });

  it('monta uma linha por pacote e avisa quando falta o resumo', () => {
    const table = coverageTable([
      { name: '@moneyflow/shared', summary },
      { name: '@moneyflow/server', summary: null },
    ]);
    const rows = table.trim().split('\n');
    assert.equal(rows[0], '## Cobertura dos testes');
    assert.equal(rows[2], '| Pacote | Linhas | Instruções | Funções | Ramos |');
    assert.equal(rows[4], '| @moneyflow/shared | 87,5% (7/8) | 75,0% (9/12) | 33,3% (1/3) | — |');
    assert.match(rows[5], /^\| @moneyflow\/server \| sem resumo/);
    // A linha do aviso tem as mesmas colunas da tabela.
    assert.equal(rows[5].split('|').length, rows[2].split('|').length);
  });

  it('lê o coverage/coverage-summary.json de cada pacote (o ausente vira null)', () => {
    const root = mkdtempSync(join(tmpdir(), 'coverage-summary-'));
    try {
      mkdirSync(join(root, 'a', 'coverage'), { recursive: true });
      writeFileSync(join(root, 'a', 'coverage', 'coverage-summary.json'), JSON.stringify(summary));
      const read = readSummaries(root, [
        { name: 'a', dir: 'a' },
        { name: 'b', dir: 'b' },
      ]);
      assert.deepEqual(read, [
        { name: 'a', summary },
        { name: 'b', summary: null },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
