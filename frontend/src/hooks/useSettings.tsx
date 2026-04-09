import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { api } from "../api/client";

export interface AppSettings {
  crossRefEnabled: boolean;
  darkMode: boolean;
  ebay: {
    enabled: boolean;
    connected: boolean;
    quarantinedCount: number;
  };
  apiKey: {
    exists: boolean;
    prefix: string | null;
    scopes: string[];
  };
}

interface SettingsContextValue {
  settings: AppSettings | null;
  setSettings: (s: AppSettings | null) => void;
  refresh: () => Promise<AppSettings | null>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettingsState] = useState<AppSettings | null>(null);

  const setSettings = useCallback((s: AppSettings | null) => {
    setSettingsState(s);
    document.documentElement.classList.toggle("dark", !!s?.darkMode);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const data = await api<AppSettings>("/api/settings");
      setSettings(data);
      return data;
    } catch {
      return null;
    }
  }, [setSettings]);

  return (
    <SettingsContext.Provider value={{ settings, setSettings, refresh }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used within SettingsProvider");
  return ctx;
}
