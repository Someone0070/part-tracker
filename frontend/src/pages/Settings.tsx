import { useState, useEffect, type FormEvent, type ReactNode } from "react";
import { api } from "../api/client";
import { useAuth } from "../hooks/useAuth";
import { Toggle } from "../components/Toggle";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";

interface AppSettings {
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

const ALL_SCOPES = [
  { value: "parts:read", label: "Parts - Read" },
  { value: "parts:write", label: "Parts - Write" },
  { value: "appliances:read", label: "Appliances - Read" },
  { value: "appliances:write", label: "Appliances - Write" },
] as const;

export function Settings() {
  const { logout, changePassword } = useAuth();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  useEffect(() => {
    fetchSettings();
  }, []);

  async function fetchSettings() {
    setLoading(true);
    try {
      const data = await api<AppSettings>("/api/settings");
      setSettings(data);
      document.documentElement.classList.toggle("dark", data.darkMode);
    } catch {
      // stay on loading state
    } finally {
      setLoading(false);
    }
  }

  async function updateSetting(key: string, value: boolean) {
    if (!settings) return;

    // Optimistic update
    const prev = { ...settings };
    if (key === "ebayEnabled") {
      setSettings({ ...settings, ebay: { ...settings.ebay, enabled: value } });
    } else {
      setSettings({ ...settings, [key]: value });
    }

    try {
      const body: Record<string, boolean> = {};
      if (key === "crossRefEnabled") body.crossRefEnabled = value;
      if (key === "darkMode") body.darkMode = value;
      if (key === "ebayEnabled") body.ebayEnabled = value;

      await api("/api/settings", {
        method: "PUT",
        body: JSON.stringify(body),
      });

      if (key === "darkMode") {
        document.documentElement.classList.toggle("dark", value);
      }
    } catch {
      setSettings(prev);
    }
  }


  if (loading || !settings) {
    return (
      <div className="pt-4">
        <div className="text-center py-12 text-sm text-gray-500 dark:text-gray-400">Loading...</div>
      </div>
    );
  }

  return (
    <>
      <div className="pt-4 space-y-6">
        <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100">Settings</h1>

        {/* General */}
        <section>
          <h2 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">General</h2>
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700">
            <SettingRow
              icon="dark_mode"
              label="Dark mode"
              description="Switch to dark theme"
              action={<Toggle checked={settings.darkMode} onChange={(v) => updateSetting("darkMode", v)} />}
            />
          </div>
        </section>

        {/* API Key */}
        <ApiKeySection settings={settings} onRefresh={fetchSettings} />

        {/* Account */}
        <section>
          <h2 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">Account</h2>
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700">
            <SettingRow
              icon="lock"
              label="Change password"
              action={
                <button
                  onClick={() => setShowPasswordModal(true)}
                  className="px-3 py-1.5 text-xs font-medium rounded-md bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  Change
                </button>
              }
            />
            <SettingRow
              icon="logout"
              label="Log out"
              action={
                <button
                  onClick={() => setShowLogoutConfirm(true)}
                  className="px-3 py-1.5 text-xs font-medium rounded-md text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40"
                >
                  Log out
                </button>
              }
            />
          </div>
        </section>
      </div>

      {showPasswordModal && (
        <ChangePasswordModal
          onClose={() => setShowPasswordModal(false)}
          onSubmit={changePassword}
        />
      )}

      <ConfirmDialog
        open={showLogoutConfirm}
        onClose={() => setShowLogoutConfirm(false)}
        onConfirm={logout}
        title="Log out"
        message="Are you sure you want to log out?"
        confirmLabel="Log out"
        destructive
      />

    </>
  );
}

function ApiKeySection({ settings, onRefresh }: { settings: AppSettings; onRefresh: () => void }) {
  const [showKey, setShowKey] = useState<string | null>(null);
  const [selectedScopes, setSelectedScopes] = useState<string[]>(
    settings.apiKey.scopes.length > 0 ? settings.apiKey.scopes : ALL_SCOPES.map((s) => s.value)
  );
  const [generating, setGenerating] = useState(false);
  const [showRevokeConfirm, setShowRevokeConfirm] = useState(false);
  const [copied, setCopied] = useState(false);

  function toggleScope(scope: string) {
    setSelectedScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]
    );
  }

  async function generateKey() {
    if (selectedScopes.length === 0) return;
    setGenerating(true);
    try {
      const data = await api<{ key: string }>("/api/settings/api-key", {
        method: "POST",
        body: JSON.stringify({ scopes: selectedScopes }),
      });
      setShowKey(data.key);
      onRefresh();
    } catch {
      // error handled by api client
    } finally {
      setGenerating(false);
    }
  }

  async function revokeKey() {
    try {
      await api("/api/settings/api-key", { method: "DELETE" });
      setShowKey(null);
      onRefresh();
    } catch {
      // error handled by api client
    }
  }

  function copyKey() {
    if (!showKey) return;
    navigator.clipboard.writeText(showKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <section>
      <h2 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">API Key</h2>
      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-3">
        {showKey && (
          <div className="space-y-2">
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Copy this key now -- it won't be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-gray-100 dark:bg-gray-800 px-2 py-1.5 rounded font-mono break-all text-gray-900 dark:text-gray-100">
                {showKey}
              </code>
              <button
                onClick={copyKey}
                className="shrink-0 px-2 py-1.5 text-xs font-medium rounded-md bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        )}

        {settings.apiKey.exists && !showKey && (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Icon name="key" size={16} className="text-gray-400" />
              <span className="text-sm text-gray-900 dark:text-gray-100">
                Active key: <code className="text-xs bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded font-mono">{settings.apiKey.prefix}...</code>
              </span>
            </div>
            <button
              onClick={() => setShowRevokeConfirm(true)}
              className="text-xs text-red-600 dark:text-red-400 font-medium hover:underline"
            >
              Revoke
            </button>
          </div>
        )}

        {!settings.apiKey.exists && !showKey && (
          <p className="text-sm text-gray-500 dark:text-gray-400">No API key configured.</p>
        )}

        <div>
          <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">Scopes</p>
          <div className="grid grid-cols-2 gap-1.5">
            {ALL_SCOPES.map((scope) => (
              <label key={scope.value} className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedScopes.includes(scope.value)}
                  onChange={() => toggleScope(scope.value)}
                  className="rounded border-gray-300 dark:border-gray-600"
                />
                {scope.label}
              </label>
            ))}
          </div>
        </div>

        <button
          onClick={generateKey}
          disabled={generating || selectedScopes.length === 0}
          className="w-full px-3 py-1.5 text-xs font-medium rounded-md bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-50"
        >
          {generating ? "Generating..." : settings.apiKey.exists ? "Regenerate Key" : "Generate Key"}
        </button>

        <p className="text-xs text-gray-400 dark:text-gray-500">
          Use header <code className="font-mono">X-API-Key: your-key</code> to authenticate.
        </p>
      </div>

      <ConfirmDialog
        open={showRevokeConfirm}
        onClose={() => setShowRevokeConfirm(false)}
        onConfirm={revokeKey}
        title="Revoke API key"
        message="This will immediately invalidate the current API key. Any tools using it will stop working."
        confirmLabel="Revoke"
        destructive
      />
    </section>
  );
}

function ChangePasswordModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (current: string, next: string) => Promise<void> }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    setError("");
    setLoading(true);
    try {
      await onSubmit(currentPassword, newPassword);
    } catch (err: any) {
      setError(err.message || "Failed to change password");
      setLoading(false);
    }
  }

  return (
    <Modal open={true} onClose={onClose} title="Change Password">
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="block text-sm text-gray-700 dark:text-gray-300 mb-1">Current password</label>
          <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required maxLength={72} className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100" />
        </div>
        <div>
          <label className="block text-sm text-gray-700 dark:text-gray-300 mb-1">New password</label>
          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={8} maxLength={72} className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100" />
        </div>
        <div>
          <label className="block text-sm text-gray-700 dark:text-gray-300 mb-1">Confirm new password</label>
          <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required minLength={8} maxLength={72} className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-gray-900 dark:focus:ring-gray-100" />
        </div>
        {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs font-medium rounded-md bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">Cancel</button>
          <button type="submit" disabled={loading} className="px-3 py-1.5 text-xs font-medium rounded-md bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200 disabled:opacity-50">{loading ? "Saving..." : "Change Password"}</button>
        </div>
      </form>
    </Modal>
  );
}

function SettingRow({ icon, label, description, action }: { icon: string; label: string; description?: string; action: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-3 py-3">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <Icon name={icon} size={20} className="text-gray-400 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{label}</p>
          {description && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>}
        </div>
      </div>
      <div className="shrink-0 ml-3">{action}</div>
    </div>
  );
}
