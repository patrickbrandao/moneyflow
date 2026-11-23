/*
 * O que a verificação rápida roda para uma lista de arquivos alterados (tarefa 127). Funções puras, sem git nem
 * processo: o scripts/verify.mjs as chama e o scripts/verify-plan.test.mjs as testa (`pnpm test:scripts`).
 */
import { basename } from 'node:path';

export const PACKAGES = {
  'apps/server': '@moneyflow/server',
  'apps/web': '@moneyflow/web',
  'packages/shared': '@moneyflow/shared',
  'packages/db': '@moneyflow/db',
  e2e: '@moneyflow/e2e',
};
/** Mudou um destes: typecheck de todos os pacotes. */
export const ROOT_CONFIG = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.base.json']);
/** Mudou a configuração do Biome: lint do repositório inteiro, não só dos arquivos alterados. */
export const LINT_CONFIG = new Set(['biome.json', 'biome.jsonc']);
export const LINTABLE = /\.(m?[jt]sx?|json|css)$/;
/** Entradas dos testes de scripts/ (node --test): os próprios scripts, o mapa e o que o check-versions lê. */
const SCRIPT_INPUTS =
  /^(scripts\/|apps\/server\/test\/related\.json$|\.nvmrc$|\.npmrc$|Dockerfile$|database\/docker\/Dockerfile$|(database\/)?docker-compose\.yml$|\.github\/workflows\/|apps\/server\/build\.mjs$|(apps\/[^/]+\/|packages\/[^/]+\/|e2e\/)?package\.json$)/;

export function packageOf(file) {
  return Object.keys(PACKAGES).find((dir) => file.startsWith(`${dir}/`));
}

/** Glob do mapa: `*` casa dentro de uma pasta, `**` em qualquer profundidade (inclusive nenhuma). */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * Testes de integração (caminhos relativos a apps/server) para os arquivos alterados, apagados inclusive:
 * o test/*.test.ts alterado, os do mapa (apps/server/test/related.json) e o de mesmo nome de apps/server/src.
 * `unmapped` lista os arquivos de apps/server/src sem nenhum teste: o verify:quick falha com eles.
 */
export function selectServerTests(files, { map, exists }) {
  const rules = Object.entries(map).map(([glob, tests]) => [globToRegExp(glob), tests]);
  const tests = new Set();
  const unmapped = [];
  for (const file of files) {
    let covered = false;
    if (/^apps\/server\/test\/[^/]+\.test\.ts$/.test(file)) {
      if (exists(file)) tests.add(file.slice('apps/server/'.length));
      continue;
    }
    for (const [re, mapped] of rules) {
      if (!re.test(file)) continue;
      for (const t of mapped) tests.add(t);
      covered = true;
    }
    if (!/^apps\/server\/src\/.+\.ts$/.test(file)) continue;
    const sameName = `test/${basename(file).replace(/(\.d)?\.ts$/, '')}.test.ts`;
    if (exists(`apps/server/${sameName}`)) {
      tests.add(sameName);
      covered = true;
    }
    if (!covered) unmapped.push(file);
  }
  return { tests: [...tests].sort(), unmapped };
}

/**
 * Pacotes para o typecheck: os dos arquivos alterados ou apagados (um arquivo apagado quebra quem o importava), ou
 * `all` quando a configuração da raiz mudou.
 */
export function typecheckPlan(files) {
  if (files.some((f) => ROOT_CONFIG.has(f))) return { all: true, packages: [] };
  return { all: false, packages: [...new Set(files.map(packageOf).filter(Boolean))].sort() };
}

/** Lint: o repositório inteiro se a configuração do Biome mudou; senão, só os arquivos alterados que ainda existem. */
export function lintPlan(existing) {
  if (existing.some((f) => LINT_CONFIG.has(f))) return { full: true, files: [] };
  return { full: false, files: existing.filter((f) => LINTABLE.test(f) && !f.startsWith('database/')) };
}

/** Os testes de scripts/ (node --test) rodam quando um script ou o que eles conferem mudou. */
export function needsScriptTests(files) {
  return files.some((f) => SCRIPT_INPUTS.test(f));
}
