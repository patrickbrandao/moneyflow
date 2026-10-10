// Pós-processamento determinístico do `drizzle-kit pull` (parte da geração,
// não é edição manual): o drizzle-kit não conhece `citext` e emite
// `unknown("col")`; trocamos pelo tipo customizado de src/citext.ts. Também
// apaga a "migration" e o snapshot que o pull grava (as migrations são do
// dbmate, em database/).
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('../src/generated/', import.meta.url).pathname;
const file = join(dir, 'schema.ts');
let src = readFileSync(file, 'utf8');
src = src.replace(/^\s*\/\/ TODO: failed to parse database type 'citext'\n/gm, '');
src = src.replace(/\bunknown\(/g, 'citext(');
if (src.includes('citext(') && !src.includes("from '../citext'")) {
  src = `import { citext } from '../citext';\n${src}`;
}
if (/\bunknown\(|TODO: failed to parse/.test(src)) {
  console.error('postpull: tipo de coluna desconhecido no schema gerado; trate em scripts/postpull.mjs');
  process.exit(1);
}
writeFileSync(file, src);

for (const entry of readdirSync(dir)) {
  if (entry.endsWith('.sql') || entry === 'meta') rmSync(join(dir, entry), { recursive: true, force: true });
}
console.log('postpull: schema gerado em src/generated');
