import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import { api, setAccessToken } from "../api/client";
import { useSettings, type AppSettings } from "./useSettings";

interface AuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (password: string) => Promise<void>;
  logout: () => Promise<void>;
  changePassword: (
    currentPassword: string,
    newPassword: string
  ) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const { setSettings } = useSettings();

  useEffect(() => {
    let cancelled = false;
    async function tryRefresh() {
      try {
        const res = await fetch("/api/auth/refresh", { method: "POST" });
        if (res.ok) {
          const data = await res.json();
          setAccessToken(data.accessToken);
          if (data.settings) {
            setSettings(data.settings as AppSettings);
          }
          if (!cancelled) setIsAuthenticated(true);
        }
      } catch {
        // No valid session
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    tryRefresh();
    return () => {
      cancelled = true;
    };
  }, [setSettings]);

  const login = useCallback(async (password: string) => {
    const data = await api<{ accessToken: string }>("/api/auth/verify", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    setAccessToken(data.accessToken);
    setIsAuthenticated(true);
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      setAccessToken(null);
      setIsAuthenticated(false);
    }
  }, []);

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      await api("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setAccessToken(null);
      setIsAuthenticated(false);
    },
    []
  );

  return (
    <AuthContext.Provider
      value={{ isAuthenticated, isLoading, login, logout, changePassword }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
