import { type Me, t } from '@moneyflow/shared';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ApiError, api, setUnauthorizedHandler } from './api';

/*
 * Autenticação contra a API: cookie httpOnly de sessão (spec 002). O estado
 * inicial vem de GET /api/auth/me; um 401 em qualquer chamada derruba a
 * sessão local e volta ao login com o aviso.
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
  notice: string | null;
  login: (identifier: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthApi | null>(null);

const toUser = (me: Me): User => ({ ...me, name: me.username, avatarUrl: null });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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
      setUser((current) => {
        if (current) setNotice(t.auth.sessionExpired);
        return null;
      });
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = useCallback(async (identifier: string, password: string) => {
    const me = await api.post<Me>('/api/auth/login', { login: identifier, password });
    setNotice(null);
    setUser(toUser(me));
  }, []);

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout').catch(() => null);
    setUser(null);
  }, []);

  const value = useMemo<AuthApi>(() => ({ user, ready, notice, login, logout, refresh }), [user, ready, notice, login, logout, refresh]);
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
