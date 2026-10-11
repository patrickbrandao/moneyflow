// Pós-processamento determinístico do `drizzle-kit pull` (parte da geração,
// não é edição manual): o drizzle-kit não conhece `citext` nem `bytea` e emite
// `unknown("col")`; trocamos pelos tipos customizados de src/citext.ts e
// src/bytea.ts (o comentário TODO que precede a coluna diz o tipo). Também
// apaga a "migration" e o snapshot que o pull grava (as migrations são do
// dbmate, em database/).
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('../src/generated/', import.meta.url).pathname;
const file = join(dir, 'schema.ts');
let src = readFileSync(file, 'utf8');
// Colunas com TODO explícito: o tipo vem no comentário.
src = src.replace(/^\s*\/\/ TODO: failed to parse database type '(bytea|citext)'\n(\s*\w+: )unknown\(/gm, '$2$1(');
// citext às vezes sai sem o comentário.
src = src.replace(/\bunknown\(/g, 'citext(');
for (const type of ['citext', 'bytea']) {
  if (new RegExp(`\\b${type}\\(`).test(src) && !src.includes(`from '../${type}'`)) {
    src = `import { ${type} } from '../${type}';\n${src}`;
  }
}
// FK em ciclo com uma tabela declarada mais adiante (ex.: classification_rules ⇄
// statement_lines) faz o TypeScript desistir da inferência (TS7022). As FKs do
// schema Drizzle não são usadas em runtime (o banco as garante e as migrations são
// do dbmate), então a referência adiante é removida daqui.
const tableAt = new Map([...src.matchAll(/export const (\w+) = pgTable\(/g)].map((m) => [m[1], m.index]));
src = src.replace(
  /^\s*foreignKey\(\{\s*columns: \[[^\]]*\],\s*foreignColumns: \[(\w+)\.[^\]]*\],\s*name: ["']([^"']+)["'],?\s*\}\)(?:\.on(?:Delete|Update)\(["'][^"']+["']\))*,?\n/gm,
  (block, target, name, offset) => {
    const at = tableAt.get(target);
    if (at === undefined || at < offset) return block;
    // Só quando há ciclo: a tabela-alvo também referencia a tabela deste bloco.
    const owner = [...tableAt].filter(([, pos]) => pos < offset).sort((a, b) => b[1] - a[1])[0]?.[0];
    const next = [...tableAt.values()].filter((pos) => pos > at).sort((a, b) => a - b)[0] ?? src.length;
    if (!owner || !src.slice(at, next).includes(`foreignColumns: [${owner}.`)) return block;
    console.log(`postpull: FK ${name} omitida (referência adiante a ${target})`);
    return '';
  },
);
// Import que sobra sem uso.
if (!/AnyPgColumn\b(?![^\n]*from)/.test(src.replace(/type AnyPgColumn,/, ''))) {
  src = src.replace(/\btype AnyPgColumn,\s*/, '');
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
