import { createPool, dbSchema } from '@moneyflow/db';
import { is } from 'drizzle-orm';
import { getTableConfig, getViewConfig, PgTable, PgView } from 'drizzle-orm/pg-core';
import { afterAll, describe, expect, inject, it } from 'vitest';

/*
 * O schema Drizzle (packages/db/src/generated, `pnpm db:pull`) bate com o banco migrado (tarefa 163): toda tabela e
 * visão do public, com as mesmas colunas e, nas tabelas, o mesmo tipo e a mesma obrigatoriedade. Uma migration nova sem o db:pull
 * falha aqui. A comparação é pelo catálogo, não pelo texto gerado, porque a saída do drizzle-kit muda de ordem
 * conforme o banco de onde ela sai.
 */

const pool = createPool(inject('databaseUrl'), 1);
afterAll(() => pool.end());

type Column = { type: string; notNull: boolean };
type Relation = { kind: 'table' | 'view'; columns: Record<string, Column> };
const VIEW_COLUMN: Column = { type: 'view', notNull: false };

/** Nome do tipo como o format_type do Postgres o escreve, para os dois lados falarem a mesma língua. */
function normalizeType(type: string): string {
  return type
    .replace(/^timestamp with time zone$/, 'timestamptz')
    .replace(/^timestamp( without time zone)?$/, 'timestamp')
    .replace(/^time( without time zone)?$/, 'time')
    .replace(/^character varying/, 'varchar')
    .replace(/^vector\(\d+\)$/, 'vector')
    .replace(/^numeric\(.*\)$/, 'numeric');
}

async function fromDatabase(): Promise<Record<string, Relation>> {
  const { rows } = await pool.query<{ rel: string; relkind: string; col: string; type: string; notnull: boolean }>(
    `SELECT c.relname AS rel, c.relkind::text AS relkind, a.attname AS col,
            format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v') AND c.relname <> 'schema_migrations'
        AND NOT c.relispartition`,
  );
  const out: Record<string, Relation> = {};
  for (const r of rows) {
    const relation = out[r.rel] ?? { kind: r.relkind === 'v' ? 'view' : 'table', columns: {} };
    out[r.rel] = relation;
    // Na visão só o nome conta: o catálogo não marca NOT NULL nela, e o drizzle-kit perde o [] das colunas de array.
    relation.columns[r.col] = r.relkind === 'v' ? VIEW_COLUMN : { type: normalizeType(r.type), notNull: r.notnull };
  }
  return out;
}

function fromDrizzle(): Record<string, Relation> {
  const out: Record<string, Relation> = {};
  for (const value of Object.values(dbSchema)) {
    if (is(value, PgTable)) {
      const config = getTableConfig(value);
      out[config.name] = {
        kind: 'table',
        columns: Object.fromEntries(config.columns.map((c) => [c.name, { type: normalizeType(c.getSQLType()), notNull: c.notNull }])),
      };
    } else if (is(value, PgView)) {
      const config = getViewConfig(value);
      out[config.name] = {
        kind: 'view',
        columns: Object.fromEntries(
          Object.values(config.selectedFields as Record<string, { name: string }>).map((c) => [c.name, VIEW_COLUMN]),
        ),
      };
    }
  }
  return out;
}

/** As diferenças legíveis, uma por linha: relação ou coluna que falta, sobra ou mudou. */
function differences(db: Record<string, Relation>, drizzle: Record<string, Relation>): string[] {
  const out: string[] = [];
  for (const name of new Set([...Object.keys(db), ...Object.keys(drizzle)])) {
    const [a, b] = [db[name], drizzle[name]];
    if (!a || !b) {
      out.push(`${name}: ${a ? 'falta no schema Drizzle' : 'não existe no banco'}`);
      continue;
    }
    if (a.kind !== b.kind) out.push(`${name}: ${a.kind} no banco, ${b.kind} no Drizzle`);
    for (const col of new Set([...Object.keys(a.columns), ...Object.keys(b.columns)])) {
      const [x, y] = [a.columns[col], b.columns[col]];
      if (!x || !y) out.push(`${name}.${col}: ${x ? 'falta no schema Drizzle' : 'não existe no banco'}`);
      else if (x.type !== y.type || x.notNull !== y.notNull) {
        out.push(`${name}.${col}: ${x.type}${x.notNull ? ' not null' : ''} no banco, ${y.type}${y.notNull ? ' not null' : ''} no Drizzle`);
      }
    }
  }
  return out.sort();
}

describe('schema Drizzle gerado (tarefa 163)', () => {
  it('tem as tabelas e visões do banco migrado, com as mesmas colunas (tipo e NOT NULL nas tabelas)', async () => {
    const db = await fromDatabase();
    expect(Object.keys(db).length).toBeGreaterThan(50);
    expect(differences(db, fromDrizzle()), 'rode `pnpm db:pull` depois da migration').toEqual([]);
  });

  it('a comparação acusa coluna nova, coluna a menos e tipo trocado', () => {
    const base: Relation = { kind: 'table', columns: { id: { type: 'uuid', notNull: true } } };
    expect(
      differences(
        { t: { kind: 'table', columns: { ...base.columns, nova: { type: 'text', notNull: false } } }, v: { kind: 'view', columns: {} } },
        { t: { kind: 'table', columns: { id: { type: 'text', notNull: true } } } },
      ),
    ).toEqual(['t.id: uuid not null no banco, text not null no Drizzle', 't.nova: falta no schema Drizzle', 'v: falta no schema Drizzle']);
  });
});
