import { type Me, t } from '@moneyflow/shared';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, setSessionExpired, setUnauthorizedHandler } from './api';

/*
 * Autenticação contra a API: cookie httpOnly de sessão (spec 002). O estado
 * inicial vem de GET /api/auth/me. Um 401 em qualquer chamada com o console
 * aberto marca a sessão como expirada sem derrubar o console (tarefa 119): a
 * janela de login abre por cima, os pedidos que receberam o 401 esperam e são
 * repetidos se o mesmo usuário entrar; outro usuário recomeça o console limpo.
 */

export type User = Me & {
  /** Nome exibido (o usuário não tem nome próprio na F1: usa o username). */
  name: string;
  avatarUrl: string | null;
};

export const ROLE_LABEL: Record<string, string> = t.roles;

type AuthApi = {
  user: User | null;
  ready: boolean;
  /** A sessão caiu com o console aberto: a janela de login de novo está por cima. */
  expired: boolean;
  login: (identifier: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthApi | null>(null);

const toUser = (me: Me): User => ({ ...me, name: me.username, avatarUrl: null });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [expired, setExpired] = useState(false);
  const userRef = useRef<User | null>(null);
  userRef.current = user;
  /** Os pedidos que receberam o 401 e esperam o login de novo. */
  const waiters = useRef<((retry: boolean) => void)[]>([]);

  const settleWaiters = useCallback((retry: boolean) => {
    const pending = waiters.current;
    waiters.current = [];
    setSessionExpired(false);
    setExpired(false);
    for (const resolve of pending) resolve(retry);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setUser(toUser(await api.get<Me>('/api/auth/me')));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setUser(null);
      else throw error;
    }
  }, []);

  useEffect(() => {
    refresh()
      .catch(() => setUser(null))
      .finally(() => setReady(true));
  }, [refresh]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (!userRef.current) return null;
      setExpired(true);
      return new Promise<boolean>((resolve) => waiters.current.push(resolve));
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = useCallback(
    async (identifier: string, password: string) => {
      const me = await api.post<Me>('/api/auth/login', { login: identifier, password });
      const same = userRef.current?.id === me.id;
      setUser(toUser(me));
      // O mesmo usuário: os pedidos à espera seguem. Outro: falham, e o console recomeça (key no App).
      settleWaiters(same);
    },
    [settleWaiters],
  );

  const logout = useCallback(async () => {
    settleWaiters(false);
    await api.post('/api/auth/logout').catch(() => null);
    setUser(null);
  }, [settleWaiters]);

  const value = useMemo<AuthApi>(() => ({ user, ready, expired, login, logout, refresh }), [user, ready, expired, login, logout, refresh]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth fora do AuthProvider');
  return value;
}

/** Para as telas internas, que só existem com sessão. */
export function useUser(): User {
  const { user } = useAuth();
  if (!user) throw new Error('useUser sem sessão');
  return user;
}
