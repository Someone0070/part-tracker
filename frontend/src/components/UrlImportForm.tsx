import { useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { Icon } from "./Icon";

interface ParseResult {
  vendor: string;
  orderNumber: string | null;
  orderDate: string | null;
  technicianName: string | null;
  trackingNumber: string | null;
  deliveryCourier: string | null;
  items: Array<{
    partNumber: string;
    partName: string;
    quantity: number;
    unitPrice: number | null;
    shipCost: number | null;
    taxPrice: number | null;
    brand: string | null;
  }>;
  rawText: string;
}

interface Props {
  onResult: (result: ParseResult) => void;
  onError: (error: string) => void;
  onReset: () => void;
}

export function UrlImportForm({ onResult, onError, onReset }: Props) {
  const [url, setUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [cookieError, setCookieError] = useState(false);

  async function handleFetch() {
    if (!url.trim()) return;
    onReset();
    setCookieError(false);
    setFetching(true);
    try {
      const result = await api<ParseResult>("/api/import/url", {
        method: "POST",
        body: JSON.stringify({ url: url.trim() }),
      });
      onResult(result);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.errorType === "no_cookies" || err.errorType === "login_redirect") {
          setCookieError(true);
          onError(err.message);
          return;
        }
        onError(err.message);
      } else {
        onError("Failed to fetch order page");
      }
    } finally {
      setFetching(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste order URL (e.g. https://www.amazon.com/your-orders/...)"
          className="flex-1 px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500"
          onKeyDown={(e) => { if (e.key === "Enter") handleFetch(); }}
          disabled={fetching}
        />
        <button
          type="button"
          onClick={handleFetch}
          disabled={fetching || !url.trim()}
          className="px-4 py-2 text-sm rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 disabled:opacity-40 flex items-center gap-1.5"
        >
          {fetching ? (
            <>
              <Icon name="hourglass_top" size={16} className="animate-spin" />
              Fetching...
            </>
          ) : (
            <>
              <Icon name="download" size={16} />
              Fetch
            </>
          )}
        </button>
      </div>
      {cookieError && (
        <Link
          to="/settings"
          className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
        >
          <Icon name="settings" size={14} />
          Manage cookies in Settings
        </Link>
      )}
    </div>
  );
}
