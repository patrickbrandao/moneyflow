/** snake_case → camelCase para linhas de SQL cru. */
export function camel<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = value;
  return out as T;
}

/**
 * Instante como ISO 8601 (UTC). O SQL cru do Drizzle devolve timestamptz como
 * texto do Postgres ('2026-10-11 02:04:29.48-03'); normaliza para o navegador.
 */
export const iso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2})(?::?(\d{2}))?$/.exec(text);
  if (!m) return text;
  const date = new Date(`${m[1]}T${m[2]}${m[3]}:${m[4] ?? '00'}`);
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
};
