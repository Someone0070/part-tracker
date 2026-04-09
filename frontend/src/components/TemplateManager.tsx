import { useState, useEffect, useCallback } from "react";
import { api } from "../api/client";
import { Icon } from "./Icon";

interface VendorTemplate {
  id: number;
  vendorKey: string;
  vendorName: string;
  successCount: number;
  failCount: number;
  createdAt: string;
  updatedAt: string;
}

export function TemplateManager() {
  const [templates, setTemplates] = useState<VendorTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<VendorTemplate[]>("/api/vendor-templates");
      setTemplates(data);
    } catch {
      // handled by api client
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleDelete(id: number) {
    setDeleting(id);
    try {
      await api(`/api/vendor-templates/${id}`, { method: "DELETE" });
      setTemplates((prev) => prev.filter((t) => t.id !== id));
    } catch {
      // handled by api client
    } finally {
      setDeleting(null);
    }
  }

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
        <p className="text-xs text-gray-400 dark:text-gray-500">Loading...</p>
      </div>
    );
  }

  if (templates.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
        <p className="text-sm text-gray-500 dark:text-gray-400">No learned templates yet. Upload a PDF to start learning.</p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700">
      {templates.map((t) => (
        <div key={t.id} className="flex items-center justify-between px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
              {t.vendorName}
            </p>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
              {t.successCount} ok / {t.failCount} fail
            </p>
          </div>
          <button
            type="button"
            onClick={() => handleDelete(t.id)}
            disabled={deleting === t.id}
            className="shrink-0 ml-3 p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
            title={`Delete ${t.vendorName} template`}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
