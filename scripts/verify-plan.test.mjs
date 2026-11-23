// Testes da seleção do verify:quick (tarefa 127): `pnpm test:scripts`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { globToRegExp, lintPlan, needsScriptTests, selectServerTests, typecheckPlan } from './verify-plan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAP = JSON.parse(readFileSync(join(ROOT, 'apps/server/test/related.json'), 'utf8')).map;
const inRepo = (file) => existsSync(join(ROOT, file));

describe('globToRegExp', () => {
  it('* fica na pasta e ** atravessa pastas', () => {
    assert.ok(globToRegExp('apps/server/src/services/series*.ts').test('apps/server/src/services/series-core.ts'));
    assert.ok(!globToRegExp('apps/server/src/services/*.ts').test('apps/server/src/services/backup/import.ts'));
    assert.ok(globToRegExp('apps/server/src/services/backup/**').test('apps/server/src/services/backup/import.ts'));
    assert.ok(globToRegExp('a/**/b.ts').test('a/b.ts'));
    assert.ok(globToRegExp('a/**/b.ts').test('a/x/y/b.ts'));
  });
});

describe('selectServerTests (o mapa real)', () => {
  it('reconciliation.ts roda o test/statements.test.ts sem argumento extra', () => {
    const { tests, unmapped } = selectServerTests(['apps/server/src/services/reconciliation.ts'], { map: MAP, exists: inRepo });
    assert.ok(tests.includes('test/statements.test.ts'));
    assert.deepEqual(unmapped, []);
  });

  it('a regra do shared usada pela integração leva os testes dela', () => {
    const { tests } = selectServerTests(['packages/shared/src/reconcile.ts'], { map: MAP, exists: inRepo });
    assert.ok(tests.includes('test/statements.test.ts'));
    assert.ok(tests.includes('test/contracts.test.ts'));
  });

  it('o arquivo apagado ainda escolhe os testes da área', () => {
    const { tests, unmapped } = selectServerTests(['apps/server/src/services/planned-account.ts'], { map: MAP, exists: () => false });
    assert.ok(tests.includes('test/contracts.test.ts'));
    assert.deepEqual(unmapped, []);
  });

  it('o mesmo nome continua valendo, e o teste alterado roda ele mesmo', () => {
    const { tests } = selectServerTests(['apps/server/src/services/notes.ts', 'apps/server/test/cards.test.ts'], {
      map: MAP,
      exists: inRepo,
    });
    assert.ok(tests.includes('test/notes.test.ts'));
    assert.ok(tests.includes('test/cards.test.ts'));
  });

  it('arquivo de src sem teste mapeado vai para unmapped; fora de src não', () => {
    const { tests, unmapped } = selectServerTests(['apps/server/src/services/novo-servico.ts', 'apps/web/src/App.tsx', 'docs/INDEX.md'], {
      map: MAP,
      exists: inRepo,
    });
    assert.deepEqual(tests, []);
    assert.deepEqual(unmapped, ['apps/server/src/services/novo-servico.ts']);
  });

  it('teste apagado não é passado ao vitest', () => {
    const { tests } = selectServerTests(['apps/server/test/apagado.test.ts'], { map: {}, exists: () => false });
    assert.deepEqual(tests, []);
  });
});

describe('typecheckPlan e lintPlan', () => {
  it('o arquivo apagado marca o pacote dele para o typecheck', () => {
    assert.deepEqual(typecheckPlan(['apps/server/src/services/planned-account.ts']), { all: false, packages: ['apps/server'] });
    assert.deepEqual(typecheckPlan(['tsconfig.base.json']), { all: true, packages: [] });
  });

  it('o biome.json alterado pede o lint do repositório inteiro', () => {
    assert.deepEqual(lintPlan(['biome.json', 'apps/web/src/App.tsx']), { full: true, files: [] });
    assert.deepEqual(lintPlan(['apps/web/src/App.tsx', 'database/schema.sql', 'docs/INDEX.md']), {
      full: false,
      files: ['apps/web/src/App.tsx'],
    });
  });

  it('os testes dos scripts rodam quando um script ou uma versão conferida muda', () => {
    assert.ok(needsScriptTests(['scripts/verify.mjs']));
    assert.ok(needsScriptTests(['Dockerfile']));
    assert.ok(needsScriptTests(['apps/server/package.json']));
    assert.ok(needsScriptTests(['apps/server/test/related.json']));
    assert.ok(!needsScriptTests(['apps/server/src/services/notes.ts']));
  });
});

describe('o mapa do repositório (apps/server/test/related.json)', () => {
  it('todo arquivo de apps/server/src tem teste: pelo mapa ou pelo mesmo nome', () => {
    const files = execFileSync('git', ['ls-files', 'apps/server/src'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((f) => f.endsWith('.ts'));
    assert.ok(files.length > 50);
    assert.deepEqual(selectServerTests(files, { map: MAP, exists: inRepo }).unmapped, []);
  });

  it('todo teste citado no mapa existe, e todo glob casa com algum arquivo', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n');
    for (const [glob, tests] of Object.entries(MAP)) {
      for (const test of tests) assert.ok(inRepo(join('apps/server', test)), `${glob} → ${test} não existe`);
      const re = globToRegExp(glob);
      assert.ok(
        tracked.some((f) => re.test(f)),
        `${glob} não casa com nenhum arquivo`,
      );
    }
  });
});
