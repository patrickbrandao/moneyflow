/** snake_case → camelCase para linhas de SQL cru. */
export function camel<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = value;
  return out as T;
}

export const iso = (value: unknown): string | null =>
  value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : String(value);
