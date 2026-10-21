// Pós-processamento determinístico do `drizzle-kit pull` (parte da geração,
// não é edição manual): o drizzle-kit não conhece `citext` nem `bytea` e emite
// `unknown("col")`; trocamos pelos tipos customizados de src/citext.ts,
// src/bytea.ts e src/tsvector.ts (o comentário TODO que precede a coluna diz o tipo). Também
// apaga a "migration" e o snapshot que o pull grava (as migrations são do
// dbmate, em database/).
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = new URL('../src/generated/', import.meta.url).pathname;
const file = join(dir, 'schema.ts');
let src = readFileSync(file, 'utf8');
// Colunas com TODO explícito: o tipo vem no comentário.
src = src.replace(/^\s*\/\/ TODO: failed to parse database type '(bytea|citext|tsvector)'\n(\s*\w+: )unknown\(/gm, '$2$1(');
// citext às vezes sai sem o comentário.
src = src.replace(/\bunknown\(/g, 'citext(');
for (const type of ['citext', 'bytea', 'tsvector']) {
  if (new RegExp(`\\b${type}\\(`).test(src) && !src.includes(`from '../${type}'`)) {
    src = `import { ${type} } from '../${type}';\n${src}`;
  }
}
// Default de texto vazio sai como `.default(')` (bug do drizzle-kit com `DEFAULT ''`).
src = src.replace(/\.default\('\)/g, ".default('')");
// Default "hoje em São Paulo" sai cortado (`((now() AT TIME ZONE 'America/Sao_Paulo'`): o drizzle-kit
// para no primeiro `)` do cast. Recompõe a expressão do banco.
src = src.replace(
  /\.default\(sql`\(\(now\(\) AT TIME ZONE 'America\/Sao_Paulo'`\)/g,
  ".default(sql`((now() AT TIME ZONE 'America/Sao_Paulo'))::date`)",
);
// FK em ciclo com uma tabela declarada mais adiante (ex.: classification_rules ⇄
// statement_lines, ou ai_runs → ai_conversations → ai_messages → ai_runs) faz o
// TypeScript desistir da inferência (TS7022). As FKs do schema Drizzle não são
// usadas em runtime (o banco as garante e as migrations são do dbmate), então a
// referência adiante que fecha um ciclo (de qualquer tamanho) é removida daqui.
const tableAt = new Map([...src.matchAll(/export const (\w+) = pgTable\(/g)].map((m) => [m[1], m.index]));
const ordered = [...tableAt].sort((a, b) => a[1] - b[1]);
const blockOf = (name) => {
  const at = tableAt.get(name);
  const next = ordered.find(([, pos]) => pos > at)?.[1] ?? src.length;
  return src.slice(at, next);
};
const refs = new Map(
  ordered.map(([name]) => [
    name,
    new Set([...blockOf(name).matchAll(/foreignColumns: \[(\w+)\./g)].map((m) => m[1]).filter((t) => t !== name)),
  ]),
);
const reaches = (from, to) => {
  const seen = new Set();
  const stack = [from];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === to) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of refs.get(current) ?? []) stack.push(next);
  }
  return false;
};
src = src.replace(
  /^\s*foreignKey\(\{\s*columns: \[[^\]]*\],\s*foreignColumns: \[(\w+)\.[^\]]*\],\s*name: ["']([^"']+)["'],?\s*\}\)(?:\.on(?:Delete|Update)\(["'][^"']+["']\))*,?\n/gm,
  (block, target, name, offset) => {
    const at = tableAt.get(target);
    if (at === undefined || at < offset) return block;
    const owner = ordered.filter(([, pos]) => pos < offset).at(-1)?.[0];
    // Só quando há ciclo: a tabela-alvo alcança, pelas FKs, a tabela deste bloco.
    if (!owner || !reaches(target, owner)) return block;
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

// FKs compostas (ex.: (contract_cycle_id, contract_id) → contract_cycles) saem como
// relações repetidas com a mesma chave no relations.ts (TS1117). As relações não
// modelam FK composta mesmo; a repetição é descartada (fica a primeira).
const relFile = join(dir, 'relations.ts');
const relLines = readFileSync(relFile, 'utf8').split('\n');
const relOut = [];
let seen = null;
let skipping = false;
for (const line of relLines) {
  if (/^export const \w+ = relations\(/.test(line)) {
    seen = new Set();
    skipping = false;
  }
  const entry = /^(?:\t| {2})(\w+): /.exec(line);
  if (seen && (entry || /^\}\)\);/.test(line))) {
    skipping = false;
    if (entry) {
      if (seen.has(entry[1])) {
        console.log(`postpull: relação repetida ${entry[1]} omitida`);
        skipping = true;
        continue;
      }
      seen.add(entry[1]);
    }
  }
  if (!skipping) relOut.push(line);
}
writeFileSync(relFile, relOut.join('\n'));

for (const entry of readdirSync(dir)) {
  if (entry.endsWith('.sql') || entry === 'meta') rmSync(join(dir, entry), { recursive: true, force: true });
}
console.log('postpull: schema gerado em src/generated');
