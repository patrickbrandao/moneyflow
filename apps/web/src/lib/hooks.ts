import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../components/Toast';
import { ApiError, api } from './api';

/*
 * Leitura com estado (carregando, erro, recarregar) e escrita com aviso de
 * erro. Sem cache global: cada tela pede o que mostra e recarrega após salvar.
 */

export type Resource<T> = {
  /** O dado do `path` atual; `undefined` enquanto ele carrega (o de um caminho anterior nunca aparece aqui, salvo `keepPrevious`). */
  data: T | undefined;
  /** Só com `keepPrevious`: `data` ainda é de um caminho anterior e o do atual está a caminho. */
  stale: boolean;
  error: ApiError | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: (value: T | ((current: T | undefined) => T)) => void;
};

type Loaded<T> = { path: string | null; data: T | undefined; error: ApiError | null };

/**
 * GET em `path` (null = não buscar). O dado fica preso ao caminho de onde veio
 * (tarefa 117): ao trocar de `path`, `data` volta a `undefined` até a resposta
 * nova, e a tela mostra o esqueleto em vez dos números da escolha anterior.
 * Cada busca tem um número: só a última pedida é aplicada, mesmo no mesmo
 * caminho, e a anterior é abortada (tarefa 118). `keepPrevious` mantém o dado
 * anterior com `stale: true`, para a tela esmaecê-lo sem desmontar (o canvas).
 */
export function useApi<T>(path: string | null, options?: { keepPrevious?: boolean }): Resource<T> {
  const keepPrevious = options?.keepPrevious ?? false;
  const [loaded, setLoaded] = useState<Loaded<T>>({ path: null, data: undefined, error: null });
  const [inflight, setInflight] = useState(false);
  const latest = useRef(path);
  latest.current = path;
  const seq = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    controller.current?.abort();
    const mine = ++seq.current;
    if (!path) {
      controller.current = null;
      setInflight(false);
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setInflight(true);
    try {
      const value = await api.get<T>(path, undefined, { signal: abort.signal });
      if (mine === seq.current) setLoaded({ path, data: value, error: null });
    } catch (err) {
      if (mine === seq.current) {
        const error = err instanceof ApiError ? err : new ApiError(0, 'unknown', String(err));
        // Uma recarga que falha mantém o dado do mesmo caminho, com o erro ao lado.
        setLoaded((current) => ({ path, data: current.path === path ? current.data : undefined, error }));
      }
    } finally {
      if (mine === seq.current) {
        controller.current = null;
        setInflight(false);
      }
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () => () => {
      seq.current += 1;
      controller.current?.abort();
    },
    [],
  );

  const setData = useCallback((value: T | ((current: T | undefined) => T)) => {
    setLoaded((current) => {
      const own = current.path === latest.current ? current.data : undefined;
      const next = typeof value === 'function' ? (value as (current: T | undefined) => T)(own) : value;
      return { path: latest.current, data: next, error: null };
    });
  }, []);

  const fresh = path !== null && loaded.path === path;
  const stale = keepPrevious && path !== null && !fresh && loaded.data !== undefined;
  return {
    data: fresh || stale ? loaded.data : undefined,
    stale,
    error: fresh ? loaded.error : null,
    loading: path !== null && (inflight || !fresh),
    reload: load,
    setData,
  };
}

/** Tamanho de página das listagens que cortam no servidor (títulos, compras, entidades, transferências). */
export const LIST_PAGE = 300;
/** Páginas no máximo ("Carregar mais" até 900 linhas): o teto das rotas é 1000, e a última página ainda cabe com a sonda de +1. */
const LIST_MAX_PAGES = 3;

/**
 * Limite de uma listagem que corta no servidor (tarefa 116): começa em uma
 * página, "Carregar mais" pede a mesma consulta com mais uma página (a ordem
 * tem desempate pelo id, então nada se repete nem fica de fora), e volta ao
 * início quando o filtro (`resetKey`) muda. `growing` = já carregou mais
 * (a tela mantém as linhas atuais enquanto a lista maior chega).
 */
export function useListLimit(resetKey: string) {
  const [state, setState] = useState({ key: resetKey, limit: LIST_PAGE });
  const limit = state.key === resetKey ? state.limit : LIST_PAGE;
  const canMore = limit < LIST_PAGE * LIST_MAX_PAGES;
  const more = useCallback(() => {
    if (canMore) setState({ key: resetKey, limit: limit + LIST_PAGE });
  }, [resetKey, limit, canMore]);
  return { limit, more, canMore, growing: limit > LIST_PAGE };
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
        // A sessão caiu e quem estava aqui saiu (ou entrou outro): a janela da sessão já disse tudo.
        if (!(error instanceof ApiError && error.code === 'session_expired')) {
          toast.error(error instanceof Error ? error.message : String(error));
        }
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { run, busy };
}
