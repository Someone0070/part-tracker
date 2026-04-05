import { useState, useEffect, type FormEvent, type ReactNode } from "react";
import { api } from "../api/client";
import { useAuth } from "../hooks/useAuth";
import { Toggle } from "../components/Toggle";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { StatusBadge } from "../components/StatusBadge";

interface SettingsData {
  crossRefEnabled: boolean;
  darkMode: boolean;
  ebayConnected: boolean;
  ebayPaused: boolean;
  ebayQuarantined: boolean;
}

export function Settings() {
  const { logout, changePassword } = useAuth();
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);

  useEffect(() => {
    fetchSettings();
  }, []);

  async function fetchSettings() {
    setLoading(true);
    try {
      const data = await api<SettingsData>("/api/settings");
      setSettings(data);
    } catch {
      // stay on loading state
    } finally {
      setLoading(false);
    }
  }

  async function updateSetting(key: keyof SettingsData, value: boolean) {
    if (!settings) return;
    const prev = settings[key];
    setSettings({ ...settings, [key]: value });
    try {
      await api("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ [key]: value }),
      });
      if (key === "darkMode") {
        document.documentElement.classList.toggle("dark", value);
      }
    } catch {
      setSettings({ ...settings, [key]: prev });
    }
  }

  async function handleDisconnectEbay() {
    try {
      await api("/api/ebay/disconnect", { method: "POST" });
      fetchSettings();
    } catch {
      // ignore
    }
  }

  async function handleConnectEbay() {
    try {
      const data = await api<{ url: string }>("/api/ebay/connect");
      window.location.href = data.url;
    } catch {
      // ignore
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
              icon="sync"
              label="Cross-references"
              description="Auto-fetch interchangeable part numbers"
              action={<Toggle checked={settings.crossRefEnabled} onChange={(v) => updateSetting("crossRefEnabled", v)} />}
            />
            <SettingRow
              icon="dark_mode"
              label="Dark mode"
              description="Switch to dark theme"
              action={<Toggle checked={settings.darkMode} onChange={(v) => updateSetting("darkMode", v)} />}
            />
          </div>
        </section>

        {/* eBay */}
        <section>
          <h2 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">eBay Integration</h2>
          <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700">
            {settings.ebayConnected ? (
              <>
                <SettingRow
                  icon="store"
                  label="eBay connected"
                  description={
                    settings.ebayQuarantined
                      ? "Sync paused due to repeated errors"
                      : settings.ebayPaused
                        ? "Sync is paused"
                        : "Syncing active listings"
                  }
                  action={
                    <div className="flex items-center gap-2">
                      {settings.ebayQuarantined && <StatusBadge variant="warning">Quarantined</StatusBadge>}
                      <button
                        onClick={() => setShowDisconnectConfirm(true)}
                        className="text-xs text-red-600 dark:text-red-400 font-medium hover:underline"
                      >
                        Disconnect
                      </button>
                    </div>
                  }
                />
                <SettingRow
                  icon="pause_circle"
                  label="Pause sync"
                  description="Temporarily stop eBay sync"
                  action={<Toggle checked={settings.ebayPaused} onChange={(v) => updateSetting("ebayPaused", v)} disabled={settings.ebayQuarantined} />}
                />
              </>
            ) : (
              <SettingRow
                icon="store"
                label="Connect eBay"
                description="Sync listings and track sold items"
                action={
                  <button
                    onClick={handleConnectEbay}
                    className="px-3 py-1.5 text-xs font-medium rounded-md bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200"
                  >
                    Connect
                  </button>
                }
              />
            )}
          </div>
        </section>

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

      <ConfirmDialog
        open={showDisconnectConfirm}
        onClose={() => setShowDisconnectConfirm(false)}
        onConfirm={handleDisconnectEbay}
        title="Disconnect eBay"
        message="This will stop syncing listings and remove the eBay connection. You can reconnect later."
        confirmLabel="Disconnect"
        destructive
      />
    </>
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
      // Will redirect to login since changePassword clears auth
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
