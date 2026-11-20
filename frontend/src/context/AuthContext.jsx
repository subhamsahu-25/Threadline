import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler, TOKEN_KEY } from '../lib/api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setToken(null);
      setUser(null);
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    let active = true;
    if (!getToken()) {
      setBooting(false);
      return undefined;
    }
    api
      .get('/api/auth/me')
      .then((data) => {
        if (active) setUser(data.user);
      })
      .catch((error) => {
        if (!active) return;
        // A cold-start failure must not throw away a session that is still
        // valid: only an explicit rejection from the API ends it.
        if (error?.status === 401 || error?.status === 403) setToken(null);
        setUser(null);
      })
      .finally(() => {
        if (active) setBooting(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // Signing out in one tab clears the shared token, so every other tab must
  // drop its in-memory user instead of firing anonymous requests.
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key && event.key !== TOKEN_KEY) return;
      if (!getToken()) {
        setToken(null);
        setUser(null);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Demo personas have no published password. The API issues their session
  // for seeded personas, even after seeding is switched off.
  const loginDemo = useCallback(async (email) => {
    const data = await api.post('/api/demo/session', { email });
    if (!data?.token) {
      throw new Error('The demo session could not be started. Please try again.');
    }
    setToken(data.token);
    setUser(data.user);
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } catch {
      /* the stored token may already be revoked or expired */
    }
    setToken(null);
    setUser(null);
  }, []);

  const refresh = useCallback(async () => {
    const data = await api.get('/api/auth/me');
    setUser(data.user);
    return data.user;
  }, []);

  const value = useMemo(
    () => ({ user, booting, loginDemo, logout, refresh }),
    [user, booting, loginDemo, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
