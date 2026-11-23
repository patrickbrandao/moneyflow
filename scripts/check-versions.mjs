#!/usr/bin/env node
/*
 * Confere que as versões do runtime e da cadeia de build estão fixas e batem entre si (tarefas 163, 184 e 187):
 *
 * - o Node do .nvmrc (X.Y.Z) é o da imagem (FROM node:X.Y.Z-…@sha256:…), o `engines` do package.json (>=X… <X+1), o
 *   `target` do bundle (nodeX) e a major do @types/node de todos os pacotes; o CI lê o .nvmrc (node-version-file);
 * - todo FROM dos Dockerfiles tem digest;
 * - toda action dos workflows é fixada pelo SHA do commit, todo workflow declara `permissions` e todo job tem
 *   `timeout-minutes` (o job que chama um workflow reutilizável não aceita a chave);
 * - o dbmate tem versão completa e é o mesmo nos dois compose.
 *
 *   node scripts/check-versions.mjs      (o CI roda no job check; o verify também)
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const PACKAGE_FILES = [
  'package.json',
  'apps/server/package.json',
  'apps/web/package.json',
  'packages/shared/package.json',
  'packages/db/package.json',
  'e2e/package.json',
];
export const DOCKERFILES = ['Dockerfile', 'database/docker/Dockerfile'];
export const COMPOSE_FILES = ['docker-compose.yml', 'database/docker-compose.yml'];

const major = (version) => Number(String(version).match(/\d+/)?.[0]);

/** O Node do .nvmrc contra a imagem, o engines, o target do esbuild e o @types/node. */
export function checkNode({ nvmrc, dockerfile, rootPackage, buildScript, packages }) {
  const errors = [];
  const version = nvmrc.trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) return [`.nvmrc: versão completa X.Y.Z esperada, achei "${version}"`];
  const X = major(version);

  const froms = [...dockerfile.matchAll(/^FROM\s+node:(\S+)/gm)].map((m) => m[1]);
  if (froms.length === 0) errors.push('Dockerfile: nenhum FROM node:…');
  for (const ref of froms) {
    const tag = ref.split('@')[0];
    if (!tag.startsWith(`${version}-`)) errors.push(`Dockerfile: FROM node:${tag} não é a versão do .nvmrc (${version})`);
  }

  const engines = JSON.parse(rootPackage).engines?.node ?? '';
  const range = engines.match(/^>=(\d+)\.(\d+)\.(\d+) <(\d+)$/);
  if (!range) errors.push(`package.json: engines.node "${engines}" fora do formato ">=X.Y.Z <X+1"`);
  else if (Number(range[1]) !== X || Number(range[4]) !== X + 1) {
    errors.push(`package.json: engines.node "${engines}" não é a major ${X} do .nvmrc`);
  }

  const target = buildScript.match(/target:\s*'node(\d+)'/);
  if (!target || Number(target[1]) !== X)
    errors.push(`apps/server/build.mjs: target deve ser 'node${X}' (achei ${target?.[0] ?? 'nenhum'})`);

  for (const [file, text] of Object.entries(packages)) {
    const pkg = JSON.parse(text);
    const types = pkg.devDependencies?.['@types/node'] ?? pkg.dependencies?.['@types/node'];
    if (types && major(types) !== X) errors.push(`${file}: @types/node ${types} não é a major ${X} do runtime`);
  }
  return errors;
}

/** Todo FROM com digest (a tag sozinha é republicada). */
export function checkDockerfile(file, text) {
  const errors = [];
  for (const m of text.matchAll(/^FROM\s+(\S+)/gm)) {
    const ref = m[1];
    // Estágio anterior do próprio Dockerfile (FROM node-base AS build).
    if (new RegExp(`\\bAS\\s+${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) continue;
    if (!/@sha256:[0-9a-f]{64}$/.test(ref)) errors.push(`${file}: FROM ${ref} sem digest (@sha256:…)`);
  }
  return errors;
}

/** Actions por SHA, permissions no topo, timeout-minutes por job e o Node pelo .nvmrc. */
export function checkWorkflow(file, text) {
  const errors = [];
  const lines = text.split('\n');
  for (const [i, line] of lines.entries()) {
    const m = line.match(/^\s*(?:-\s+)?uses:\s*(\S+)/);
    if (!m) continue;
    const ref = m[1];
    if (ref.startsWith('./')) continue;
    if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(ref)) errors.push(`${file}:${i + 1}: ${ref} não está fixada pelo SHA do commit`);
    else if (!/#\s*v\d/.test(line)) errors.push(`${file}:${i + 1}: ${ref} sem o comentário da versão (# vX.Y.Z)`);
  }
  if (!/^permissions:/m.test(text)) errors.push(`${file}: sem permissions no topo`);
  if (/node-version:/.test(text)) errors.push(`${file}: use node-version-file: .nvmrc, não node-version`);

  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start === -1) return [...errors, `${file}: sem jobs`];
  let job;
  const jobs = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const head = line.match(/^ {2}([\w-]+):\s*$/);
    if (head) {
      job = { name: head[1], timeout: false, reusable: false };
      jobs.push(job);
    } else if (job && /^ {4}timeout-minutes:\s*\d+/.test(line)) job.timeout = true;
    else if (job && /^ {4}uses:/.test(line)) job.reusable = true;
  }
  for (const j of jobs) if (!j.timeout && !j.reusable) errors.push(`${file}: o job ${j.name} não tem timeout-minutes`);
  return errors;
}

/** O dbmate com versão completa e igual nos dois compose. */
export function checkCompose(files) {
  const errors = [];
  const versions = new Map();
  for (const [file, text] of Object.entries(files)) {
    for (const m of text.matchAll(/image:\s*ghcr\.io\/amacneil\/dbmate:(\S+)/g)) {
      if (!/^\d+\.\d+\.\d+(@sha256:[0-9a-f]{64})?$/.test(m[1])) errors.push(`${file}: dbmate:${m[1]} sem versão completa`);
      versions.set(file, m[1]);
    }
  }
  if (new Set(versions.values()).size > 1) {
    errors.push(`dbmate com versões diferentes: ${[...versions].map(([f, v]) => `${f} → ${v}`).join(', ')}`);
  }
  return errors;
}

export function checkRepository(root = ROOT) {
  const read = (file) => readFileSync(join(root, file), 'utf8');
  const workflows = readdirSync(join(root, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f));
  return [
    ...checkNode({
      nvmrc: read('.nvmrc'),
      dockerfile: read('Dockerfile'),
      rootPackage: read('package.json'),
      buildScript: read('apps/server/build.mjs'),
      packages: Object.fromEntries(PACKAGE_FILES.map((f) => [f, read(f)])),
    }),
    ...DOCKERFILES.flatMap((f) => checkDockerfile(f, read(f))),
    ...workflows.flatMap((f) => checkWorkflow(`.github/workflows/${f}`, read(`.github/workflows/${f}`))),
    ...checkCompose(Object.fromEntries(COMPOSE_FILES.map((f) => [f, read(f)]))),
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = checkRepository();
  if (errors.length) {
    console.error(`Versões fora do lugar (${errors.length}):\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    process.exit(1);
  }
  console.log('Versões fixas e coerentes (Node, imagens, actions e dbmate).');
}
