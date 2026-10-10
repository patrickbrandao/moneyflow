import type { DeleteResult } from '@moneyflow/shared';
import { findPgError } from '../errors';

/**
 * Exclusão conforme a spec 008: tenta excluir; se houver vínculo (FK 23503),
 * arquiva. Chamado fora de transação (o DELETE que falha não contamina nada).
 */
export async function deleteOrArchive(remove: () => Promise<number>, archive: () => Promise<unknown>): Promise<DeleteResult> {
  try {
    const count = await remove();
    return { deleted: count > 0, archived: false };
  } catch (error) {
    if (findPgError(error)?.code !== '23503') throw error;
    await archive();
    return { deleted: false, archived: true };
  }
}

/** snake_case → camelCase para linhas de SQL cru. */
export function camel<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = value;
  return out as T;
}

export const iso = (value: unknown): string | null =>
  value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : String(value);
