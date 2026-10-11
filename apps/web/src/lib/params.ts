import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/** Um parâmetro da URL como estado (abre modal/gaveta por link: ?new=1, ?title=…). */
export function useParamState(name: string): [string | null, (value: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const set = useCallback(
    (value: string | null) =>
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (value === null) next.delete(name);
          else next.set(name, value);
          return next;
        },
        { replace: true },
      ),
    [name, setParams],
  );
  return [params.get(name), set];
}

/** Troca vários parâmetros de uma vez (duas chamadas seguidas ao setter se sobrescreveriam). */
export function useSetParams() {
  const [, setParams] = useSearchParams();
  return useCallback(
    (patch: Record<string, string | null>) =>
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(patch)) {
            if (value === null) next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
}
