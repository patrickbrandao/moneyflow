#!/usr/bin/env node
/*
 * Verificação em dois níveis (AGENTS.md → Verificação).
 *
 *   pnpm verify:quick [--base <ref>] [-- <args do vitest da API>]
 *     O padrão durante o desenvolvimento. Olha só o que mudou desde o ponto em
 *     que o branch saiu do main (commits, alterações e arquivos novos):
 *     lint dos arquivos alterados (o repositório inteiro se o biome.json mudou),
 *     typecheck dos pacotes afetados, inclusive por arquivo apagado (e dos que
 *     dependem deles), testes do shared relacionados, testes dos scripts,
 *     testes de integração dos arquivos tocados contra o Postgres local
 *     (MONEYFLOW_TEST_DB=local, sem container) e o pgTAP dos testes do banco
 *     alterados. Sem build, sem e2e. Os testes de integração saem de
 *     scripts/verify-plan.mjs: o test/x.test.ts alterado, o mapa
 *     apps/server/test/related.json e o de mesmo nome de src/.../x.ts. Arquivo
 *     de apps/server/src sem teste nenhum faz a verificação FALHAR (código 2)
 *     com a lista (tarefa 127); --sem-integracao pula a integração de propósito.
 *     Com args depois de `--`, a API roda exatamente esses testes:
 *       pnpm verify:quick -- test/contracts.test.ts -t "renovação"
 *
 *   pnpm verify:full [--local] [--e2e]
 *     Só quando pedido, antes de PR ou de release: lint, typecheck, todos os
 *     testes (integração em Testcontainers; --local usa o Postgres local),
 *     testes dos scripts, build e pgTAP completo. --e2e acrescenta o Playwright (pilha no ar).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { dirname, join, relative } from 'node:path';
import { lintPlan, needsScriptTests, PACKAGES, selectServerTests, typecheckPlan } from './verify-plan.mjs';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..');
process.chdir(ROOT);
const RELATED = 'apps/server/test/related.json';

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
  // Código 2 = arquivo sem teste mapeado (tarefa 127); 1 = algum passo falhou.
  const failed = results.filter((r) => r.ok === false);
  process.exit(failed.length ? Math.max(...failed.map((r) => r.code ?? 1)) : 0);
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

/** Alterados desde a base (commits, árvore e arquivos novos); `all` inclui os apagados, `existing` não. */
function changedFiles(base) {
  const tracked = git('diff', '--name-only', base).split('\n');
  const untracked = git('ls-files', '--others', '--exclude-standard').split('\n');
  const all = [...new Set([...tracked, ...untracked])].filter(Boolean);
  return { all, existing: all.filter((f) => existsSync(f)) };
}

async function quick() {
  const baseRef = option('--base') ?? (git('rev-parse', '--verify', '--quiet', 'origin/main') ? 'origin/main' : 'main');
  const base = git('merge-base', 'HEAD', baseRef) || 'HEAD';
  const { all, existing } = changedFiles(base);
  const deleted = all.filter((f) => !existing.includes(f));
  console.log(
    `Verificação rápida: ${all.length} arquivo(s) alterado(s) desde ${baseRef} (${base.slice(0, 7)})` +
      `${deleted.length ? `, ${deleted.length} apagado(s)` : ''}.`,
  );
  if (all.length === 0 && passthrough.length === 0) {
    console.log('Nada a verificar.');
    return summary();
  }

  const lint = lintPlan(existing);
  if (lint.full) run('Lint do repositório (a configuração do Biome mudou)', 'pnpm', ['lint']);
  else if (lint.files.length) {
    run('Lint dos arquivos alterados', 'pnpm', [
      'exec',
      'biome',
      'check',
      '--no-errors-on-unmatched',
      '--files-ignore-unknown=true',
      ...lint.files,
    ]);
  } else skip('Lint', 'nenhum arquivo de código alterado');

  const typecheck = typecheckPlan(all);
  if (typecheck.all) {
    run('Typecheck (todos os pacotes: configuração da raiz mudou)', 'pnpm', ['-r', 'typecheck']);
  } else if (typecheck.packages.length) {
    const filters = typecheck.packages.flatMap((dir) => ['--filter', `...${PACKAGES[dir]}`]);
    run(`Typecheck (${typecheck.packages.map((d) => PACKAGES[d]).join(', ')} e dependentes)`, 'pnpm', [...filters, 'typecheck']);
  } else skip('Typecheck', 'nenhum pacote alterado');

  const sharedFiles = existing
    .filter((f) => f.startsWith('packages/shared/') && /\.tsx?$/.test(f))
    .map((f) => relative('packages/shared', f));
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

  if (needsScriptTests(all)) run('Testes dos scripts (node --test)', 'pnpm', ['test:scripts']);
  else skip('Testes dos scripts', 'scripts e versões não mudaram');

  let serverArgs = passthrough;
  if (flag('--sem-integracao')) skip('Testes de integração', 'pedido --sem-integracao');
  else {
    if (serverArgs.length === 0) {
      const map = JSON.parse(readFileSync(RELATED, 'utf8')).map;
      const { tests, unmapped } = selectServerTests(all, { map, exists: existsSync });
      serverArgs = tests;
      if (unmapped.length) {
        results.push({
          label: `Testes de integração: ${unmapped.length} arquivo(s) de src sem teste mapeado`,
          ok: false,
          secs: '0',
          code: 2,
        });
        console.error(
          `\n✗ Sem teste de integração escolhido para:\n${unmapped.map((f) => `  - ${f}`).join('\n')}\n` +
            `  Acrescente-os em ${RELATED} (ou crie o test/<nome>.test.ts), passe os testes depois de \`--\` ` +
            'ou use --sem-integracao de propósito.',
        );
      }
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
    } else skip('Testes de integração', 'nenhum arquivo da API, do banco ou do shared mapeado mudou');
  }

  const pgtap = existing.filter((f) => /^database\/tests\/.+\.sql$/.test(f)).map((f) => `/${relative('database', f)}`);
  if (pgtap.length) {
    run('pgTAP dos testes alterados', 'make', ['-C', 'database', 'test', `T=${pgtap.join(' ')}`]);
  } else if (all.some((f) => f.startsWith('database/migrations/'))) {
    skip('pgTAP', 'migration alterada sem teste pgTAP alterado');
  } else skip('pgTAP', 'banco não mudou');

  summary('Não rodou: build, e2e e a suíte completa (pnpm verify:full).');
}

async function full() {
  const steps = [
    ['Lint', 'pnpm', ['lint']],
    ['Typecheck', 'pnpm', ['typecheck']],
    ['Testes unitários (shared)', 'pnpm', ['test:unit']],
    ['Testes dos scripts (node --test)', 'pnpm', ['test:scripts']],
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
