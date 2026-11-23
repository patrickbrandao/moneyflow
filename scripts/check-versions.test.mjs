// Testes de scripts/check-versions.mjs (tarefas 163, 184 e 187): `pnpm test:scripts`.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkCompose, checkDockerfile, checkNode, checkRepository, checkWorkflow } from './check-versions.mjs';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const SHA = 'b'.repeat(40);
const pkg = (types) => JSON.stringify({ devDependencies: { '@types/node': types } });
const node = (overrides = {}) => ({
  nvmrc: '26.13.1\n',
  dockerfile: `FROM node:26.13.1-bookworm-slim@${DIGEST} AS base\nFROM base AS build\n`,
  rootPackage: JSON.stringify({ engines: { node: '>=26.13.0 <27' } }),
  buildScript: "  target: 'node26',\n",
  packages: { 'apps/server/package.json': pkg('26.6.5'), 'e2e/package.json': pkg('26.0.1') },
  ...overrides,
});
const workflow = (body) => `name: CI\npermissions:\n  contents: read\njobs:\n${body}`;

describe('checkNode', () => {
  it('aceita tudo na versão do .nvmrc', () => {
    assert.deepEqual(checkNode(node()), []);
  });

  it('acusa a imagem, o engines, o target e o @types/node fora da major do .nvmrc', () => {
    const errors = checkNode(
      node({
        dockerfile: `FROM node:22.12.0-bookworm-slim@${DIGEST}\n`,
        rootPackage: JSON.stringify({ engines: { node: '>=22.12.0' } }),
        buildScript: "target: 'node22',",
        packages: { 'e2e/package.json': pkg('22.0.0') },
      }),
    );
    assert.equal(errors.length, 4);
    assert.match(errors[0], /node:22\.12\.0-bookworm-slim não é a versão do \.nvmrc/);
    assert.match(errors[1], /engines\.node/);
    assert.match(errors[2], /target deve ser 'node26'/);
    assert.match(errors[3], /e2e\/package\.json: @types\/node 22\.0\.0/);
  });

  it('exige a versão completa no .nvmrc', () => {
    assert.match(checkNode(node({ nvmrc: '26' }))[0], /versão completa/);
  });
});

describe('checkDockerfile', () => {
  it('exige digest em todo FROM, menos no estágio do próprio arquivo', () => {
    assert.deepEqual(checkDockerfile('Dockerfile', `FROM node:26.13.1@${DIGEST} AS base\nFROM base AS build\n`), []);
    assert.match(checkDockerfile('Dockerfile', 'FROM pgvector/pgvector:pg18\n')[0], /sem digest/);
  });
});

describe('checkWorkflow', () => {
  const job = (steps, extra = '    timeout-minutes: 10\n') => `  check:\n    runs-on: ubuntu-latest\n${extra}    steps:\n${steps}`;

  it('aceita actions pelo SHA com a versão, permissions e timeout-minutes', () => {
    assert.deepEqual(checkWorkflow('ci.yml', workflow(job(`      - uses: actions/checkout@${SHA} # v4.4.0\n`))), []);
  });

  it('acusa action por tag, SHA sem a versão, falta de permissions e de timeout-minutes', () => {
    const errors = checkWorkflow(
      'ci.yml',
      `jobs:\n${job(`      - uses: actions/checkout@v4\n      - uses: actions/setup-node@${SHA}\n`, '')}`,
    );
    assert.deepEqual(
      errors.map((e) => e.replace(/^ci\.yml(:\d+)?: /, '')),
      [
        'actions/checkout@v4 não está fixada pelo SHA do commit',
        `actions/setup-node@${SHA} sem o comentário da versão (# vX.Y.Z)`,
        'sem permissions no topo',
        'o job check não tem timeout-minutes',
      ],
    );
  });

  it('o job que chama um workflow reutilizável dispensa timeout-minutes; node-version solto não vale', () => {
    assert.deepEqual(checkWorkflow('release.yml', workflow('  ci:\n    uses: ./.github/workflows/ci.yml\n')), []);
    const errors = checkWorkflow(
      'ci.yml',
      workflow(job(`      - uses: actions/setup-node@${SHA} # v4\n        with:\n          node-version: 22\n`)),
    );
    assert.match(errors[0], /node-version-file/);
  });
});

describe('checkCompose', () => {
  it('exige o dbmate com versão completa e igual nos dois compose', () => {
    const a = 'image: ghcr.io/amacneil/dbmate:2.38.2\n';
    assert.deepEqual(checkCompose({ a, b: a }), []);
    assert.match(checkCompose({ a: 'image: ghcr.io/amacneil/dbmate:2\n' })[0], /sem versão completa/);
    assert.match(checkCompose({ a, b: 'image: ghcr.io/amacneil/dbmate:2.39.0\n' })[0], /versões diferentes/);
  });
});

describe('o repositório', () => {
  it('passa em todas as conferências', () => {
    assert.deepEqual(checkRepository(), []);
  });
});
