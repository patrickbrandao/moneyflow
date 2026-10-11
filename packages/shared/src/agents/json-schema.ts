import { z } from 'zod';
import type { AgentToolDef } from './tools';

/*
 * Zod → JSON Schema das tools (provedores de LLM e servidor MCP próprio). Usa
 * o schema de ENTRADA (antes dos transforms), tira o "$schema" e o padrão
 * enorme do uuid (fica format: uuid) e completa descrições óbvias (valores em
 * centavos, datas AAAA-MM-DD) que ajudam o modelo.
 */

export type JsonSchema = { [key: string]: unknown };

const UUID_HINT = 'Id (uuid).';
const DATE_HINT = 'Data no formato AAAA-MM-DD.';
const CENTS_HINT = 'Valor em centavos de real (inteiro; R$ 10,50 = 1050).';

function polish(node: unknown, key?: string): unknown {
  if (Array.isArray(node)) return node.map((item) => polish(item));
  if (!node || typeof node !== 'object') return node;
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(node as JsonSchema)) {
    if (k === '$schema') continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v as JsonSchema).map(([prop, schema]) => [prop, polish(schema, prop)]));
      continue;
    }
    out[k] = polish(v);
  }
  if (out.format === 'uuid') {
    delete out.pattern;
    if (!out.description) out.description = UUID_HINT;
  }
  if (key && !out.description) {
    const types = Array.isArray(out.type) ? out.type : [out.type];
    if (/Cents$/.test(key) && types.includes('integer')) out.description = CENTS_HINT;
    else if (/(Date|On)$|^(from|to)$/.test(key) && (types.includes('string') || out.anyOf)) out.description = DATE_HINT;
  }
  return out;
}

const cache = new WeakMap<z.ZodType, JsonSchema>();

/** JSON Schema (objeto) da entrada de uma tool. */
export function zodToToolSchema(schema: z.ZodType): JsonSchema {
  const hit = cache.get(schema);
  if (hit) return hit;
  const raw = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
  const result = polish(raw) as JsonSchema;
  if (result.type !== 'object') throw new Error('a entrada de uma tool precisa ser um objeto');
  if (!result.properties) result.properties = {};
  cache.set(schema, result);
  return result;
}

export function toolJsonSchema(tool: Pick<AgentToolDef, 'input'>): JsonSchema {
  return zodToToolSchema(tool.input);
}
