import { useCallback, useState } from 'react';
import { storageKey } from '../config/brand';

/**
 * `useState` que sobrevive ao recarregamento, por navegador. Para preferências
 * de quem usa (sidebar recolhida, modo grade/lista, último filtro) — nunca para
 * dado que precisa ser confiável ou compartilhado: isso é do backend.
 *
 * Toda leitura e escrita em try/catch: modo privado e storage bloqueado não
 * podem derrubar a tela.
 */
export function useStored<T>(name: string, initial: T): [T, (value: T | ((current: T) => T)) => void] {
  const key = storageKey(name);
  const [value, setValue] = useState<T>(() => readStored(key, initial));
  const set = useCallback(
    (next: T | ((current: T) => T)) => {
      setValue((current) => {
        const resolved = typeof next === 'function' ? (next as (c: T) => T)(current) : next;
        try {
          localStorage.setItem(key, JSON.stringify(resolved));
        } catch {
          // sem storage: vale só nesta aba
        }
        return resolved;
      });
    },
    [key],
  );
  return [value, set];
}

export function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: unknown) {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // idem
  }
}
