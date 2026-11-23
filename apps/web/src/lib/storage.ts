import { useCallback, useEffect, useRef, useState } from 'react';
import { storageKey } from '../config/brand';

/**
 * `useState` que sobrevive ao recarregamento, por navegador. Para preferências
 * de quem usa (sidebar recolhida, modo grade/lista, último filtro) — nunca para
 * dado que precisa ser confiável ou compartilhado: isso é do backend.
 *
 * Toda leitura e escrita em try/catch: modo privado e storage bloqueado não
 * podem derrubar a tela.
 */
export function useStored<T>(name: string, initial: T, options: { sync?: boolean } = {}): [T, (value: T | ((current: T) => T)) => void] {
  const key = storageKey(name);
  const [value, setValue] = useState<T>(() => readStored(key, initial));
  const set = useCallback(
    (next: T | ((current: T) => T)) => {
      setValue((current) => {
        const resolved = typeof next === 'function' ? (next as (c: T) => T)(current) : next;
        // O mesmo valor: nem grava nem re-renderiza (tarefa 120).
        if (Object.is(resolved, current)) return current;
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
  // `sync`: o valor gravado por outra aba (evento `storage`) vale nesta, sem gravar de volta (tarefa 183).
  const initialRef = useRef(initial);
  initialRef.current = initial;
  const sync = options.sync ?? false;
  useEffect(() => {
    if (!sync) return;
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || (event.key !== key && event.key !== null)) return;
      setValue(readStored(key, initialRef.current));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [key, sync]);
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
