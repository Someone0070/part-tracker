import { useState, useEffect, useRef, useCallback, type ChangeEvent } from "react";
import { api } from "../api/client";
import { Icon } from "./Icon";
import { ConfirmDialog } from "./ConfirmDialog";

interface VendorCookie {
  id: number;
  vendorName: string;
  domain: string;
  isPreset: boolean;
  status: string;
  cookieCount: number;
  authCookieExpiry: string | null;
  expiryWarning: string | null;
  lastTestedAt: string | null;
}

const STATUS_BADGES: Record<string, { label: string; color: string }> = {
  active: { label: "Active", color: "text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20" },
  needs_reauth: { label: "Needs re-auth", color: "text-yellow-700 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-900/20" },
  error: { label: "Error", color: "text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-900/20" },
  unconfigured: { label: "Not configured", color: "text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800" },
};

function StatusBadge({ status }: { status: string }) {
  const badge = STATUS_BADGES[status] ?? STATUS_BADGES.unconfigured;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${badge.color}`}>
      {badge.label}
    </span>
  );
}

function PasteModal({ vendor, onDone, onClose }: {
  vendor: { id: number | null; vendorName: string; domain: string };
  onDone: () => void;
  onClose: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Focus textarea on mount so paste works immediately
    textareaRef.current?.focus();
  }, []);

  const submitCookies = useCallback(async (text: string) => {
    if (!text.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      if (vendor.id) {
        await api(`/api/vendor-cookies/${vendor.id}`, {
          method: "PUT",
          body: JSON.stringify({ cookiesTxt: text }),
        });
      } else {
        await api("/api/vendor-cookies", {
          method: "POST",
          body: JSON.stringify({ vendorName: vendor.vendorName, domain: vendor.domain, cookiesTxt: text }),
        });
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save cookies");
      setSaving(false);
    }
  }, [vendor, saving, onDone]);

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    e.preventDefault();
    const text = e.clipboardData.getData("text");
    if (text.trim()) submitCookies(text);
  }

  function handleFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    file.text().then((text) => submitCookies(text));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-lg w-full max-w-md mx-4 p-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
            Add cookies for {vendor.vendorName}
          </h3>
          <button type="button" onClick={onClose} className="p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
            <Icon name="close" size={18} />
          </button>
        </div>

        {error && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-xs text-red-700 dark:text-red-400">
            {error}
          </div>
        )}

        {saving ? (
          <div className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
            Saving cookies...
          </div>
        ) : (
          <>
            <textarea
              ref={textareaRef}
              onPaste={handlePaste}
              placeholder="Paste cookies here (any format: cookies.txt, JSON, header string, or file)"
              rows={4}
              className="w-full px-3 py-2 text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder:text-gray-400 dark:placeholder:text-gray-500 resize-none"
              style={{ caretColor: "transparent" }}
            />
            <div className="flex items-center justify-between mt-3">
              <p className="text-xs text-gray-400 dark:text-gray-500">
                Paste to auto-save. Cookies are encrypted immediately.
              </p>
              <input ref={fileInputRef} type="file" accept=".txt,.json" className="sr-only" onChange={handleFileSelected} />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
              >
                <Icon name="upload_file" size={14} />
                File
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function CookieManager() {
  const [vendors, setVendors] = useState<VendorCookie[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddCustom, setShowAddCustom] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customDomain, setCustomDomain] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<VendorCookie | null>(null);
  const [error, setError] = useState("");
  const [pasteTarget, setPasteTarget] = useState<{ id: number | null; vendorName: string; domain: string } | null>(null);

  async function loadVendors() {
    try {
      const data = await api<VendorCookie[]>("/api/vendor-cookies");
      setVendors(data);
    } catch {
      setError("Failed to load cookie settings");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadVendors(); }, []);

  function openPasteForVendor(v: VendorCookie) {
    setPasteTarget({ id: v.id, vendorName: v.vendorName, domain: v.domain });
  }

  function openPasteForCustom() {
    if (!customName || !customDomain) return;
    setPasteTarget({ id: null, vendorName: customName, domain: customDomain });
  }

  async function handleDelete(vendor: VendorCookie) {
    try {
      await api(`/api/vendor-cookies/${vendor.id}`, { method: "DELETE" });
      await loadVendors();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
    setDeleteTarget(null);
  }

  if (loading) return <p className="text-sm text-gray-500 dark:text-gray-400">Loading...</p>;

  return (
    <div className="space-y-3">
      {error && (
        <div className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-xs text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {vendors.map((v) => (
        <div key={v.id} className="flex items-center justify-between gap-3 p-3 rounded-lg border border-gray-200 dark:border-gray-700">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{v.vendorName}</span>
              <StatusBadge status={v.status} />
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {v.domain}
              {v.status !== "unconfigured" && ` -- ${v.cookieCount} cookies`}
              {v.expiryWarning && ` -- ${v.expiryWarning}`}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => openPasteForVendor(v)}
              className="p-1.5 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
              title="Add cookies (paste or upload)"
            >
              <Icon name="content_paste" size={16} />
            </button>
            <button
              type="button"
              onClick={() => setDeleteTarget(v)}
              className="p-1.5 rounded-md text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
              title={v.isPreset ? "Clear cookies" : "Remove vendor"}
            >
              <Icon name="delete" size={16} />
            </button>
          </div>
        </div>
      ))}

      {!showAddCustom ? (
        <button
          type="button"
          onClick={() => setShowAddCustom(true)}
          className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"
        >
          <Icon name="add" size={16} />
          Add custom vendor
        </button>
      ) : (
        <div className="p-3 rounded-lg border border-gray-200 dark:border-gray-700 space-y-2">
          <input
            type="text"
            placeholder="Vendor name (e.g. LG Parts)"
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
            className="w-full px-3 py-1.5 text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          />
          <input
            type="text"
            placeholder="Domain (e.g. lgparts.com)"
            value={customDomain}
            onChange={(e) => setCustomDomain(e.target.value)}
            className="w-full px-3 py-1.5 text-sm rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={openPasteForCustom}
              disabled={!customName || !customDomain}
              className="px-3 py-1.5 text-xs rounded-md bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 disabled:opacity-40"
            >
              Add cookies
            </button>
            <button
              type="button"
              onClick={() => { setShowAddCustom(false); setCustomName(""); setCustomDomain(""); }}
              className="px-3 py-1.5 text-xs rounded-md text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {pasteTarget && (
        <PasteModal
          vendor={pasteTarget}
          onDone={() => {
            setPasteTarget(null);
            setShowAddCustom(false);
            setCustomName("");
            setCustomDomain("");
            loadVendors();
          }}
          onClose={() => setPasteTarget(null)}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => { if (deleteTarget) handleDelete(deleteTarget); }}
        title={deleteTarget?.isPreset ? "Clear cookies?" : "Remove vendor?"}
        message={deleteTarget?.isPreset
          ? `Clear stored cookies for ${deleteTarget.vendorName}?`
          : `Remove ${deleteTarget?.vendorName} and its stored cookies?`
        }
        confirmLabel={deleteTarget?.isPreset ? "Clear" : "Remove"}
        destructive
      />
    </div>
  );
}
