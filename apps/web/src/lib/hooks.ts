import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../components/Toast';
import { ApiError, api } from './api';

/*
 * Leitura com estado (carregando, erro, recarregar) e escrita com aviso de
 * erro. Sem cache global: cada tela pede o que mostra e recarrega após salvar.
 */

export type Resource<T> = {
  data: T | undefined;
  error: ApiError | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (value: T | ((current: T | undefined) => T)) => void;
};

/** GET em `path` (null = não buscar). Muda de `path` → busca de novo, sem pintar a resposta antiga. */
export function useApi<T>(path: string | null): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const latest = useRef(path);
  latest.current = path;

  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      const value = await api.get<T>(path);
      if (latest.current === path) {
        setData(value);
        setError(null);
      }
    } catch (err) {
      if (latest.current === path) setError(err instanceof ApiError ? err : new ApiError(0, 'unknown', String(err)));
    } finally {
      if (latest.current === path) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, error, loading, reload: load, setData: setData as Resource<T>['setData'] };
}

/** Executa uma escrita: mostra o erro em toast e devolve undefined; ou o resultado e (opcional) o aviso de sucesso. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T>(fn: () => Promise<T>, success?: string | ((value: T) => string)): Promise<T | undefined> => {
      setBusy(true);
      try {
        const value = await fn();
        if (success) toast.success(typeof success === 'function' ? success(value) : success);
        return value;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { run, busy };
}
