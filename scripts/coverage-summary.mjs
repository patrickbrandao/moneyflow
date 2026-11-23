#!/usr/bin/env node
/*
 * Resumo da cobertura dos testes em markdown (tarefa 126): lê o json-summary do @vitest/coverage-v8 de cada pacote
 * (`pnpm --filter <pacote> test:coverage` grava `coverage/coverage-summary.json`) e imprime uma tabela. O CI a
 * acrescenta ao resumo do job ($GITHUB_STEP_SUMMARY). Ainda sem piso: só mostra.
 *
 *   node scripts/coverage-summary.mjs            (os pacotes de PACKAGES)
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const PACKAGES = [
  { name: '@moneyflow/shared', dir: 'packages/shared' },
  { name: '@moneyflow/server', dir: 'apps/server' },
];

const METRICS = [
  ['lines', 'Linhas'],
  ['statements', 'Instruções'],
  ['functions', 'Funções'],
  ['branches', 'Ramos'],
];

const percent = (value) => `${Number(value).toFixed(1).replace('.', ',')}%`;

/** Uma célula: "87,5% (7/8)"; sem nada a medir, "—". */
export function cell(metric) {
  if (!metric?.total) return '—';
  return `${percent(metric.pct)} (${metric.covered}/${metric.total})`;
}

/** A tabela em markdown: uma linha por pacote; sem o resumo (os testes falharam ou não rodaram), o aviso. */
export function coverageTable(rows) {
  const lines = [
    '## Cobertura dos testes',
    '',
    `| Pacote | ${METRICS.map(([, label]) => label).join(' | ')} |`,
    `|---|${METRICS.map(() => '---:').join('|')}|`,
  ];
  for (const { name, summary } of rows) {
    if (!summary?.total) lines.push(`| ${name} | sem resumo (os testes não terminaram) |${' |'.repeat(METRICS.length - 1)}`);
    else lines.push(`| ${name} | ${METRICS.map(([key]) => cell(summary.total[key])).join(' | ')} |`);
  }
  return `${lines.join('\n')}\n`;
}

export function readSummaries(root = ROOT, packages = PACKAGES) {
  return packages.map(({ name, dir }) => {
    const file = join(root, dir, 'coverage', 'coverage-summary.json');
    return { name, summary: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(coverageTable(readSummaries()));
}
