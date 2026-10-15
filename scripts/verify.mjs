#!/usr/bin/env node
/*
 * Verificação em dois níveis (AGENTS.md → Verificação).
 *
 *   pnpm verify:quick [--base <ref>] [-- <args do vitest da API>]
 *     O padrão durante o desenvolvimento. Olha só o que mudou desde o ponto em
 *     que o branch saiu do main (commits, alterações e arquivos novos):
 *     lint dos arquivos alterados, typecheck dos pacotes afetados (e dos que
 *     dependem deles), testes do shared relacionados, testes de integração dos
 *     arquivos tocados (test/x.test.ts alterado ou de src/.../x.ts) contra o
 *     Postgres local (MONEYFLOW_TEST_DB=local, sem container) e o pgTAP dos
 *     testes do banco alterados. Sem build, sem e2e.
 *     Com args depois de `--`, a API roda exatamente esses testes:
 *       pnpm verify:quick -- test/contracts.test.ts -t "renovação"
 *
 *   pnpm verify:full [--local] [--e2e]
 *     Só quando pedido, antes de PR ou de release: lint, typecheck, todos os
 *     testes (integração em Testcontainers; --local usa o Postgres local),
 *     build e pgTAP completo. --e2e acrescenta o Playwright (pilha no ar).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Socket } from 'node:net';
import { basename, dirname, join, relative } from 'node:path';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..');
process.chdir(ROOT);

const PACKAGES = {
  'apps/server': '@moneyflow/server',
  'apps/web': '@moneyflow/web',
  'packages/shared': '@moneyflow/shared',
  'packages/db': '@moneyflow/db',
  e2e: '@moneyflow/e2e',
};
const ROOT_CONFIG = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.base.json']);
const LINTABLE = /\.(m?[jt]sx?|json|css)$/;

const argv = process.argv.slice(2);
const mode = argv.shift();
const dash = argv.indexOf('--');
const opts = dash === -1 ? argv : argv.slice(0, dash);
const passthrough = dash === -1 ? [] : argv.slice(dash + 1);
const flag = (name) => opts.includes(name);
const option = (name) => {
  const i = opts.indexOf(name);
  return i === -1 ? undefined : opts[i + 1];
};

const results = [];

function run(label, cmd, args, env = {}) {
  console.log(`\n▶ ${label}\n  $ ${[cmd, ...args].join(' ')}`);
  const start = Date.now();
  const r = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
  const ok = r.status === 0;
  results.push({ label, ok, secs: ((Date.now() - start) / 1000).toFixed(1) });
  return ok;
}

function skip(label, why) {
  results.push({ label, ok: null, why });
}

function git(...args) {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

function summary(extra) {
  console.log('\n── Resumo ──');
  for (const r of results) {
    const mark = r.ok === null ? '–' : r.ok ? '✓' : '✗';
    console.log(`${mark} ${r.label}${r.ok === null ? ` (pulado: ${r.why})` : ` (${r.secs}s)`}`);
  }
  if (extra) console.log(`\n${extra}`);
  process.exit(results.some((r) => r.ok === false) ? 1 : 0);
}

function portOpen(port, host = 'localhost') {
  return new Promise((resolve) => {
    const s = new Socket();
    s.setTimeout(1000);
    s.once('connect', () => resolve(s.destroy() || true));
    s.once('timeout', () => resolve(s.destroy() && false));
    s.once('error', () => resolve(false));
    s.connect(port, host);
  });
}

async function ensureLocalPostgres() {
  if (await portOpen(5432)) return true;
  return run('Postgres local (make -C database up)', 'make', ['-C', 'database', 'up']);
}

function changedFiles(base) {
  const tracked = git('diff', '--name-only', base).split('\n');
  const untracked = git('ls-files', '--others', '--exclude-standard').split('\n');
  return [...new Set([...tracked, ...untracked])].filter((f) => f && existsSync(f));
}

function packageOf(file) {
  return Object.keys(PACKAGES).find((dir) => file.startsWith(`${dir}/`));
}

async function quick() {
  const baseRef = option('--base') ?? (git('rev-parse', '--verify', '--quiet', 'origin/main') ? 'origin/main' : 'main');
  const base = git('merge-base', 'HEAD', baseRef) || 'HEAD';
  const files = changedFiles(base);
  console.log(`Verificação rápida: ${files.length} arquivo(s) alterado(s) desde ${baseRef} (${base.slice(0, 7)}).`);
  if (files.length === 0 && passthrough.length === 0) {
    console.log('Nada a verificar.');
    return summary();
  }

  const lintable = files.filter((f) => LINTABLE.test(f) && !f.startsWith('database/'));
  if (lintable.length) {
    run('Lint dos arquivos alterados', 'pnpm', [
      'exec',
      'biome',
      'check',
      '--no-errors-on-unmatched',
      '--files-ignore-unknown=true',
      ...lintable,
    ]);
  } else skip('Lint', 'nenhum arquivo de código alterado');

  const allPackages = files.some((f) => ROOT_CONFIG.has(f));
  const touched = [...new Set(files.map(packageOf).filter(Boolean))];
  if (allPackages) {
    run('Typecheck (todos os pacotes: configuração da raiz mudou)', 'pnpm', ['-r', 'typecheck']);
  } else if (touched.length) {
    const filters = touched.flatMap((dir) => ['--filter', `...${PACKAGES[dir]}`]);
    run(`Typecheck (${touched.map((d) => PACKAGES[d]).join(', ')} e dependentes)`, 'pnpm', [...filters, 'typecheck']);
  } else skip('Typecheck', 'nenhum pacote alterado');

  const sharedFiles = files.filter((f) => f.startsWith('packages/shared/') && /\.tsx?$/.test(f)).map((f) => relative('packages/shared', f));
  if (sharedFiles.length) {
    run('Testes do shared relacionados', 'pnpm', [
      '--filter',
      '@moneyflow/shared',
      'exec',
      'vitest',
      'related',
      '--run',
      '--passWithNoTests',
      ...sharedFiles,
    ]);
  } else skip('Testes do shared', 'shared não mudou');

  let serverArgs = passthrough;
  if (serverArgs.length === 0) {
    const tests = new Set();
    for (const f of files) {
      if (/^apps\/server\/test\/[^/]+\.test\.ts$/.test(f)) tests.add(relative('apps/server', f));
      else if (/^apps\/server\/src\/.+\.ts$/.test(f)) {
        const candidate = `test/${basename(f, '.ts')}.test.ts`;
        if (existsSync(join('apps/server', candidate))) tests.add(candidate);
      }
    }
    serverArgs = [...tests];
  }
  if (serverArgs.length) {
    if (await ensureLocalPostgres()) {
      run(
        'Testes de integração tocados (Postgres local)',
        'pnpm',
        ['--filter', '@moneyflow/server', 'exec', 'vitest', 'run', ...serverArgs],
        {
          MONEYFLOW_TEST_DB: 'local',
        },
      );
    }
  } else if (files.some((f) => f.startsWith('apps/server/') || f.startsWith('packages/'))) {
    skip('Testes de integração', 'nenhum test/*.test.ts alterado nem com o nome do arquivo de src; passe-os depois de `--`');
  } else skip('Testes de integração', 'API não mudou');

  const pgtap = files.filter((f) => /^database\/tests\/.+\.sql$/.test(f)).map((f) => `/${relative('database', f)}`);
  if (pgtap.length) {
    run('pgTAP dos testes alterados', 'make', ['-C', 'database', 'test', `T=${pgtap.join(' ')}`]);
  } else if (files.some((f) => f.startsWith('database/migrations/'))) {
    skip('pgTAP', 'migration alterada sem teste pgTAP alterado');
  } else skip('pgTAP', 'banco não mudou');

  summary('Não rodou: build, e2e e a suíte completa (pnpm verify:full).');
}

async function full() {
  const steps = [
    ['Lint', 'pnpm', ['lint']],
    ['Typecheck', 'pnpm', ['typecheck']],
    ['Testes unitários (shared)', 'pnpm', ['test:unit']],
    flag('--local')
      ? ['Testes de integração (Postgres local)', 'pnpm', ['test:integration'], { MONEYFLOW_TEST_DB: 'local' }]
      : ['Testes de integração (Testcontainers)', 'pnpm', ['test:integration']],
    ['Build', 'pnpm', ['build']],
    ['pgTAP completo', 'make', ['-C', 'database', 'test']],
  ];
  if (flag('--e2e')) steps.push(['E2E (Playwright, pilha no ar)', 'pnpm', ['e2e']]);
  if (flag('--local') && !(await ensureLocalPostgres())) return summary();
  for (const [label, cmd, args, env] of steps) {
    if (!run(label, cmd, args, env)) break;
  }
  summary(flag('--e2e') ? undefined : 'E2E não rodou (acrescente --e2e com a pilha no ar).');
}

if (mode === 'quick') await quick();
else if (mode === 'full') await full();
else {
  console.error('uso: node scripts/verify.mjs quick|full');
  process.exit(2);
}
