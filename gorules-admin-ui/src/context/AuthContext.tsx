import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/** Req 7: login state, JWT header injection and role helper hooks for the Admin UI. */

export type UserRole = 'VIEWER' | 'RULE_AUTHOR' | 'RULE_APPROVER' | 'ADMIN';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
}

interface AuthState {
  user: AuthUser | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  /** fetch() with the Bearer token injected; throws on non-2xx with the API error message. */
  apiFetch: (url: string, init?: RequestInit) => Promise<any>;
  can: (action: 'edit' | 'approve') => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

const TOKEN_KEY = 'uw_jwt_token';
const USER_KEY = 'uw_jwt_user';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() => {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw ? (JSON.parse(raw) as AuthUser) : null;
    } catch {
      return null;
    }
  });

  const login = useCallback(async (username: string, password: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `Login failed (${res.status})`);
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    setUser(data.user);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setUser(null);
  }, []);

  const apiFetch = useCallback(async (url: string, init: RequestInit = {}) => {
    const token = localStorage.getItem(TOKEN_KEY);
    const res = await fetch(url, {
      ...init,
      headers: {
        ...(init.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err: any = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }, []);

  const can = useCallback(
    (action: 'edit' | 'approve') => {
      if (!user) return false;
      if (user.role === 'ADMIN') return true;
      return action === 'edit' ? user.role === 'RULE_AUTHOR' : user.role === 'RULE_APPROVER';
    },
    [user],
  );

  const value = useMemo(() => ({ user, login, logout, apiFetch, can }), [user, login, logout, apiFetch, can]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
